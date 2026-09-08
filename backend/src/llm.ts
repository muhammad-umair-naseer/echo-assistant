/**
 * Groq chat (Llama 3.3 70B) over the OpenAI-compatible endpoint, via plain
 * fetch — no SDK needed for one route. The whole app must run WITHOUT a key:
 * hasKey() gates every call and the server degrades to a clear "add your key"
 * state while memory keeps working.
 */
import "dotenv/config";

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
export const MODEL = "llama-3.3-70b-versatile";

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export function hasKey(): boolean {
  return !!process.env.GROQ_API_KEY;
}

/** Stream a chat completion token-by-token. Yields content deltas. */
export async function* streamChat(messages: ChatMessage[]): AsyncGenerator<string> {
  const res = await fetch(GROQ_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({ model: MODEL, messages, stream: true, temperature: 0.6 }),
  });
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    throw new Error(`groq ${res.status}: ${detail.slice(0, 300)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
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
        const delta = JSON.parse(data).choices?.[0]?.delta?.content;
        if (delta) yield delta as string;
      } catch {
        /* partial frame — ignored, completed on next chunk */
      }
    }
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
  "remembering across sessions (name, projects, preferences, relationships, " +
  "circumstances). Return a JSON array of short standalone strings, each " +
  'phrased about the user (e.g. ["user\'s name is Ada"]). Return [] if there is ' +
  "nothing durable. JSON only.";

/** LLM-based fact extraction. Throws on any failure; caller falls back to heuristics. */
export async function extractFactsLLM(userMessage: string): Promise<string[]> {
  const raw = await completeOnce([
    { role: "system", content: EXTRACT_PROMPT },
    { role: "user", content: userMessage },
  ]);
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) return [];
  const arr = JSON.parse(match[0]) as unknown;
  if (!Array.isArray(arr)) return [];
  return arr.filter((f): f is string => typeof f === "string" && f.length >= 4 && f.length <= 200);
}
