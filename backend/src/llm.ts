/**
 * Groq chat (Llama 3.3 70B) over the OpenAI-compatible endpoint, via plain
 * fetch — no SDK needed for one route. The whole app must run WITHOUT a key:
 * hasKey() gates every call and the server degrades to a clear "add your key"
 * state while memory keeps working.
 */
import "dotenv/config";

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
// Groq rotates its catalogue (llama-3.3-70b-versatile was retired); default to
// the strongest current open model and let .env override without a code change.
export const MODEL = process.env.GROQ_MODEL ?? "openai/gpt-oss-120b";

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: import("./tools.ts").ToolCall[];
  tool_call_id?: string;
};

export type StreamEvent = { type: "token"; t: string } | { type: "tools"; calls: import("./tools.ts").ToolCall[] };

export function hasKey(): boolean {
  return !!process.env.GROQ_API_KEY;
}

/** Stream a chat completion token-by-token. Yields content deltas. */
export async function* streamChat(messages: ChatMessage[]): AsyncGenerator<string> {
  for await (const ev of streamChatEvents(messages)) {
    if (ev.type === "token") yield ev.t;
  }
}

/**
 * Stream a completion that may CALL TOOLS: token events stream out live; if the
 * model finishes by requesting tool calls (streamed as argument deltas,
 * accumulated by index), one final {type:"tools"} event carries them.
 */
export async function* streamChatEvents(messages: ChatMessage[], tools?: unknown): AsyncGenerator<StreamEvent> {
  const res = await fetch(GROQ_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({ model: MODEL, messages, stream: true, temperature: 0.6, ...(tools ? { tools } : {}) }),
  });
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    throw new Error(`groq ${res.status}: ${detail.slice(0, 300)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  // Tool-call deltas accumulate by index: id + name arrive once, arguments in pieces.
  const pending = new Map<number, { id: string; name: string; args: string }>();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    // SSE frames: lines of `data: {...}` separated by blank lines.
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const data = line.trim().replace(/^data:\s*/, "");
      if (!data || data === "[DONE]" || !line.startsWith("data:")) continue;
      try {
        const delta = JSON.parse(data).choices?.[0]?.delta as
          | { content?: string; tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[] }
          | undefined;
        if (delta?.content) yield { type: "token", t: delta.content };
        for (const tc of delta?.tool_calls ?? []) {
          const slot = pending.get(tc.index) ?? { id: "", name: "", args: "" };
          if (tc.id) slot.id = tc.id;
          if (tc.function?.name) slot.name = tc.function.name;
          if (tc.function?.arguments) slot.args += tc.function.arguments;
          pending.set(tc.index, slot);
        }
      } catch {
        /* partial frame — ignored, completed on next chunk */
      }
    }
  }
  if (pending.size > 0) {
    const calls = [...pending.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, s2]) => ({ id: s2.id, type: "function" as const, function: { name: s2.name, arguments: s2.args } }));
    yield { type: "tools", calls };
  }
}

/** One-shot (non-streaming) completion, used by LLM fact extraction. */
export async function completeOnce(messages: ChatMessage[], maxTokens = 300): Promise<string> {
  const res = await fetch(GROQ_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({ model: MODEL, messages, max_tokens: maxTokens, temperature: 0 }),
  });
  if (!res.ok) throw new Error(`groq ${res.status}`);
  const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return json.choices?.[0]?.message?.content ?? "";
}

const EXTRACT_PROMPT =
  "Extract durable facts about the user from their message — things worth " +
  "remembering across sessions. Return a JSON array of objects " +
  '{"fact": string, "category": "identity"|"preference"|"project"|"relationship"|"context"|"misc"}, ' +
  'each fact short and phrased about the user (e.g. {"fact":"user\'s name is Ada","category":"identity"}). ' +
  "Return [] if there is nothing durable. JSON only.";

/** LLM-based fact extraction (with categories). Throws on failure; caller falls back to heuristics. */
export async function extractFactsLLM(userMessage: string): Promise<{ fact: string; category?: string }[]> {
  const raw = await completeOnce([
    { role: "system", content: EXTRACT_PROMPT },
    { role: "user", content: userMessage },
  ]);
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) return [];
  const arr = JSON.parse(match[0]) as unknown;
  if (!Array.isArray(arr)) return [];
  const CATS = new Set(["identity", "preference", "project", "relationship", "context", "misc"]);
  return arr
    .map((f) =>
      typeof f === "string"
        ? { fact: f }
        : f && typeof f === "object" && typeof (f as { fact?: unknown }).fact === "string"
          ? {
              fact: (f as { fact: string }).fact,
              category: CATS.has(String((f as { category?: unknown }).category)) ? String((f as { category?: unknown }).category) : undefined,
            }
          : null,
    )
    .filter((f): f is { fact: string; category?: string } => !!f && f.fact.length >= 4 && f.fact.length <= 200);
}

const SUPERSEDE_PROMPT =
  "A user stated a NEW fact. Given EXISTING remembered facts, decide which " +
  "existing facts the new one REPLACES (same attribute of the same subject, " +
  "value changed — e.g. moved cities, renamed, changed preference). Unrelated " +
  "or merely similar facts are NOT replaced. Reply with JSON only: " +
  '{"replaces": [ids]} — an empty array if none.';

/** LLM judge for contradiction resolution. Returns ids of retired facts. */
export async function judgeSupersede(
  newFact: string,
  candidates: { id: number; fact: string }[],
): Promise<number[]> {
  const raw = await completeOnce(
    [
      { role: "system", content: SUPERSEDE_PROMPT },
      {
        role: "user",
        content: `NEW: ${newFact}\nEXISTING:\n${candidates.map((c) => `#${c.id}: ${c.fact}`).join("\n")}`,
      },
    ],
    400,
  );
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return [];
  const parsed = JSON.parse(m[0]) as { replaces?: unknown };
  return Array.isArray(parsed.replaces) ? parsed.replaces.filter((x): x is number => Number.isInteger(x)) : [];
}
