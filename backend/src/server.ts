/**
 * The ECHO backend. One chat route that runs the full memory loop per message:
 *
 *   recall (embed query → top-k memories) → inject into system prompt →
 *   stream the model's reply token-by-token (SSE) →
 *   extract durable facts from what the user said → embed → dedup → persist.
 *
 * Runs fully without GROQ_API_KEY: chat degrades to a clear "add your key"
 * message (streamed, so the UI behaves identically), while recall, extraction
 * (heuristic), storage, and the /api/memory inspector all keep working.
 */
import express from "express";
import { addMessage, allMemories, deleteMemory, listSessions, openDb, sessionMessages } from "./db.ts";
import { buildSystemPrompt, extractFactsHeuristic, remember } from "./memory.ts";
import { extractFactsLLM, hasKey, judgeSupersede, MODEL, streamChatEvents, type ChatMessage } from "./llm.ts";
import { execTool, TOOL_DEFS, type ToolCall } from "./tools.ts";

const PORT = Number(process.env.PORT ?? 8790);
const db = openDb();
const app = express();
app.use(express.json());

const NO_KEY_REPLY =
  "no GROQ_API_KEY configured. add it to backend/.env and restart to bring the " +
  "language model online. memory systems remain operational — facts you state " +
  "are still being extracted, embedded and stored.";

app.get("/api/status", (_req, res) => {
  res.json({ hasKey: hasKey(), hasTts: hasTtsKey(), model: MODEL, memories: allMemories(db).length });
});

// ---- ElevenLabs TTS (optional key; browser speechSynthesis is the fallback) --
const hasTtsKey = () => !!process.env.ELEVENLABS_API_KEY;
const EL_VOICE = process.env.ELEVENLABS_VOICE ?? "onwK4e9ZLuTAKqWW03F9"; // "Daniel" — composed, JARVIS-adjacent

/** Text → mp3 bytes via ElevenLabs. One sentence per call (the client queues). */
app.post("/api/tts", async (req, res) => {
  if (!hasTtsKey()) {
    res.status(400).json({ error: "no ELEVENLABS_API_KEY" });
    return;
  }
  const { text } = (req.body ?? {}) as { text?: unknown };
  if (typeof text !== "string" || !text.trim() || text.length > 800) {
    res.status(400).json({ error: "text required (<=800 chars)" });
    return;
  }
  try {
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${EL_VOICE}?output_format=mp3_22050_32`, {
      method: "POST",
      headers: { "xi-api-key": process.env.ELEVENLABS_API_KEY!, "content-type": "application/json" },
      body: JSON.stringify({ text, model_id: "eleven_turbo_v2_5" }),
    });
    if (!r.ok) {
      res.status(502).json({ error: `elevenlabs ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}` });
      return;
    }
    res.setHeader("content-type", "audio/mpeg");
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch (err) {
    res.status(502).json({ error: `tts failed: ${(err as Error).message}` });
  }
});

const STT_MODEL = process.env.GROQ_STT_MODEL ?? "whisper-large-v3-turbo";

/** Speech-to-text via Groq Whisper — the same key as chat, no Google involved.
 *  Body: raw audio (webm/opus from MediaRecorder). Returns { text }. */
app.post("/api/transcribe", express.raw({ type: () => true, limit: "20mb" }), async (req, res) => {
  if (!hasKey()) {
    res.status(400).json({ error: "no GROQ_API_KEY — whisper transcription needs it" });
    return;
  }
  const audio = req.body as Buffer;
  if (!audio || audio.length < 100) {
    res.status(400).json({ error: "no audio received" });
    return;
  }
  try {
    const form = new FormData();
    const type = req.headers["content-type"] ?? "audio/webm";
    form.append("file", new Blob([new Uint8Array(audio)], { type }), "speech.webm");
    form.append("model", STT_MODEL);
    const r = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      body: form,
    });
    if (!r.ok) {
      const detail = await r.text().catch(() => "");
      res.status(502).json({ error: `groq whisper ${r.status}: ${detail.slice(0, 200)}` });
      return;
    }
    const json = (await r.json()) as { text?: string };
    res.json({ text: (json.text ?? "").trim() });
  } catch (err) {
    res.status(502).json({ error: `transcription failed: ${(err as Error).message}` });
  }
});

app.get("/api/sessions", (_req, res) => {
  res.json(listSessions(db));
});

app.get("/api/session/:id", (req, res) => {
  res.json(
    sessionMessages(db, req.params.id, 500).map((m) => ({
      role: m.role,
      content: m.content,
      created_at: m.created_at,
    })),
  );
});

app.get("/api/memory", (_req, res) => {
  res.json(
    allMemories(db).map((m) => ({
      id: m.id,
      fact: m.fact,
      source: m.source,
      category: m.category,
      created_at: m.created_at,
    })),
  );
});

/** Export the whole memory bank as portable JSON. */
app.get("/api/memory/export", (_req, res) => {
  res.setHeader("content-disposition", "attachment; filename=jarvis-memories.json");
  res.json(allMemories(db).map((m) => ({ fact: m.fact, category: m.category, created_at: m.created_at })));
});

/** Import memories (JSON array of {fact, category?}) through the normal
 *  remember() path — embedded, deduped, contradiction-checked. */
app.post("/api/memory/import", async (req, res) => {
  const body = req.body as unknown;
  if (!Array.isArray(body)) {
    res.status(400).json({ error: "expected a JSON array of {fact, category?}" });
    return;
  }
  const facts = body
    .filter((f): f is { fact: string; category?: string } => !!f && typeof (f as { fact?: unknown }).fact === "string")
    .slice(0, 500);
  const stored = await remember(db, facts, "import");
  res.json({ imported: stored.length, skippedAsDuplicate: facts.length - stored.length });
});

app.delete("/api/memory/:id", (req, res) => {
  res.json({ deleted: deleteMemory(db, Number(req.params.id)) });
});

app.post("/api/chat", async (req, res) => {
  // Express 5 leaves req.body undefined for missing/non-JSON bodies — guard the
  // shape explicitly so a bad request gets a 400 JSON, not a 500 HTML page.
  const { sessionId, message } = (req.body ?? {}) as { sessionId?: unknown; message?: unknown };
  if (typeof sessionId !== "string" || !sessionId || typeof message !== "string" || !message.trim()) {
    res.status(400).json({ error: "sessionId and message required" });
    return;
  }

  res.setHeader("content-type", "text/event-stream");
  res.setHeader("cache-control", "no-cache");
  res.flushHeaders();
  const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  try {
    // READ PATH — retrieve only what's relevant, never the whole history.
    const { prompt, recalled } = await buildSystemPrompt(db, message, true);
    send("meta", { recalled, hasKey: hasKey() });

    addMessage(db, sessionId, "user", message);
    let reply = "";
    if (hasKey()) {
      const history = sessionMessages(db, sessionId).map(
        (m) => ({ role: m.role, content: m.content }) as ChatMessage,
      );
      // Tool loop: stream tokens live; when the model requests tools, execute
      // them server-side, surface each as an SSE `tool` event (and `action` for
      // client-side effects like open_url), then let it continue. Max 4 rounds.
      const convo: ChatMessage[] = [{ role: "system", content: prompt }, ...history];
      for (let round = 0; round < 4; round++) {
        let calls: ToolCall[] = [];
        let roundText = "";
        for await (const ev of streamChatEvents(convo, TOOL_DEFS)) {
          if (ev.type === "token") {
            roundText += ev.t;
            reply += ev.t;
            send("token", { t: ev.t });
          } else {
            calls = ev.calls;
          }
        }
        if (calls.length === 0) break;
        convo.push({ role: "assistant", content: roundText || null, tool_calls: calls });
        for (const call of calls) {
          send("tool", { name: call.function.name, args: call.function.arguments.slice(0, 200) });
          const out = await execTool(call);
          if (out.clientAction) send("action", out.clientAction);
          convo.push({ role: "tool", content: out.result, tool_call_id: call.id });
        }
      }
    } else {
      // Keyless: stream the degraded reply word-by-word so the console types it.
      reply = NO_KEY_REPLY;
      for (const word of NO_KEY_REPLY.split(/(?<= )/)) send("token", { t: word });
    }
    addMessage(db, sessionId, "assistant", reply);

    // WRITE PATH — extract durable facts and persist them as embeddings.
    let facts: (string | { fact: string; category?: string })[];
    let source = "heuristic";
    if (hasKey()) {
      try {
        facts = await extractFactsLLM(message);
        source = "llm";
      } catch {
        facts = extractFactsHeuristic(message);
      }
    } else {
      facts = extractFactsHeuristic(message);
    }
    const remembered = await remember(db, facts, source, hasKey() ? judgeSupersede : undefined);
    send("done", { remembered });
  } catch (err) {
    send("error", { message: (err as Error).message });
  } finally {
    res.end();
  }
});

app.listen(PORT, () => console.log(`echo-assistant backend on http://localhost:${PORT} (key: ${hasKey()})`));
