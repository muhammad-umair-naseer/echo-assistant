import { useCallback, useEffect, useRef, useState } from "react";
import { chat, getStatus, listMemories, removeMemory, type Status } from "./api.ts";
import { SentenceStreamer } from "./voice/sentences.ts";
import { WebSpeechStt, WebSpeechTts } from "./voice/webSpeech.ts";

type LineKind = "sys" | "user" | "echo" | "mem" | "err";
interface Line {
  id: number;
  kind: LineKind;
  text: string;
}

type Phase = "boot" | "idle" | "thinking" | "streaming";

const SPINNER = ["|", "/", "-", "\\"];
let nextId = 1;

const reducedMotion = () =>
  typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

export function Terminal() {
  const [lines, setLines] = useState<Line[]>([]);
  const [streamText, setStreamText] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("boot");
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<Status | null>(null);
  const [spin, setSpin] = useState(0);

  // voice
  const [voiceOn, setVoiceOn] = useState(() => localStorage.getItem("echo-voice") === "1");
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [speaking, setSpeaking] = useState(0); // active/queued utterances

  const sessionId = useRef<string>(crypto.randomUUID());
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const stt = useRef(new WebSpeechStt());
  const tts = useRef(new WebSpeechTts());
  const busy = useRef(false);
  const activeStreamer = useRef<SentenceStreamer | null>(null); // so Esc/voice-off can mute mid-reply

  const push = useCallback((kind: LineKind, text: string) => {
    setLines((ls) => [...ls, { id: nextId++, kind, text }]);
  }, []);

  /** Type a line character-by-character (the boot cadence); instant under reduced motion. */
  const typeLine = useCallback((kind: LineKind, text: string, cps = 4): Promise<void> => {
    if (reducedMotion()) {
      setLines((ls) => [...ls, { id: nextId++, kind, text }]);
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const id = nextId++;
      setLines((ls) => [...ls, { id, kind, text: "" }]);
      const start = performance.now();
      const msPerChar = cps / 3;
      const tick = setInterval(() => {
        // Time-based, not tick-based: background tabs throttle intervals to
        // ~1Hz, and elapsed-time reveal keeps boot from crawling when hidden.
        const i = Math.min(text.length, Math.ceil((performance.now() - start) / msPerChar));
        setLines((ls) => ls.map((l) => (l.id === id ? { ...l, text: text.slice(0, i) } : l)));
        if (i >= text.length) {
          clearInterval(tick);
          resolve();
        }
      }, cps);
    });
  }, []);

  // ---- boot sequence: the one orchestrated moment ---------------------------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const st = await getStatus().catch(() => null);
      if (cancelled) return;
      setStatus(st);
      await typeLine("sys", "ECHO ▮ personal assistant kernel v0.3.0");
      await typeLine("sys", `memory core ............ online (${st?.memories ?? 0} facts indexed)`);
      if (st?.hasKey) {
        await typeLine("sys", `llm link ............... ${st.model} via groq · online`);
      } else if (st) {
        await typeLine("err", "llm link ............... OFFLINE — add GROQ_API_KEY to backend/.env");
        await typeLine("sys", "memory systems operate without the key. facts you state are stored.");
      } else {
        await typeLine("err", "backend ................ UNREACHABLE — run: cd backend && npm run server");
      }
      await typeLine(
        "sys",
        stt.current.available()
          ? "voice io ............... ready (◉ mic to talk · voice toggle for spoken replies)"
          : "voice io ............... unavailable in this browser (chat still works)",
      );
      await typeLine("sys", "READY. type a message · /help for commands");
      if (!cancelled) setPhase("idle");
    })();
    return () => {
      cancelled = true;
    };
  }, [typeLine]);

  // thinking spinner (text frames — terminal metaphor, no tween)
  useEffect(() => {
    if (phase !== "thinking") return;
    const t = setInterval(() => setSpin((s) => (s + 1) % SPINNER.length), 120);
    return () => clearInterval(t);
  }, [phase]);

  // keep scrolled to the newest line
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines, streamText, phase, interim, listening]);

  // Escape cancels listening and speech, anywhere — including sentences the
  // streamer hasn't emitted yet (mute it, or speech resumes on the next boundary).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      stt.current.cancel();
      setListening(false);
      setInterim("");
      activeStreamer.current?.stop();
      tts.current.cancel();
      setSpeaking(0);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const toggleVoice = () => {
    setVoiceOn((v) => {
      const next = !v;
      localStorage.setItem("echo-voice", next ? "1" : "0");
      if (!next) {
        activeStreamer.current?.stop(); // silence the rest of a streaming reply too
        tts.current.cancel();
        setSpeaking(0);
      }
      return next;
    });
  };

  const mic = () => {
    if (!stt.current.available() || phase === "boot") return;
    if (listening) {
      stt.current.stop(); // finalize what was heard
      return;
    }
    tts.current.cancel(); // don't transcribe our own speech
    setSpeaking(0);
    setListening(true);
    setInterim("");
    stt.current.start({
      onPartial: (t) => setInterim(t),
      onFinal: (t) =>
        void send(t).then((ok) => {
          if (!ok) push("sys", `(busy — voice input dropped: "${t}")`); // never silent
        }),
      onEnd: () => {
        setListening(false);
        setInterim("");
      },
    });
  };

  /** The command palette. `/memory` makes the hard part VISIBLE: what the
   *  assistant knows about you, where each fact came from, and a way to erase. */
  const runCommand = async (raw: string) => {
    const [cmd, sub, ...rest] = raw.slice(1).trim().split(/\s+/);
    switch ((cmd ?? "").toLowerCase()) {
      case "help":
        push("sys", "┌─ ECHO commands ─────────────────────────────┐");
        push("sys", "│ /memory        list everything I remember    │");
        push("sys", "│ /memory rm <id>  delete one memory           │");
        push("sys", "│ /voice         toggle spoken replies         │");
        push("sys", "│ /clear         wipe screen + start a new     │");
        push("sys", "│                session (memories survive)    │");
        push("sys", "│ /help          this panel                    │");
        push("sys", "└──────────────────────────────────────────────┘");
        push("sys", "◉ mic = push-to-talk · Esc cancels voice");
        break;

      case "memory": {
        if (sub === "rm" && rest[0]) {
          const id = Number(rest[0]);
          const ok = Number.isInteger(id) && (await removeMemory(id).catch(() => false));
          push(ok ? "mem" : "err", ok ? `[mem-] deleted memory #${id}` : `[err] no memory #${rest[0]}`);
          getStatus().then(setStatus).catch(() => {});
          break;
        }
        const mems = await listMemories().catch(() => null);
        if (!mems) {
          push("err", "[err] backend unreachable");
          break;
        }
        if (mems.length === 0) {
          push("mem", "[memory] empty. tell me something about yourself.");
          break;
        }
        push("mem", `[memory] ${mems.length} fact${mems.length > 1 ? "s" : ""} on file:`);
        for (const m of mems) {
          const date = m.created_at.slice(0, 10);
          push("mem", `  #${String(m.id).padStart(3, " ")} ${m.fact}  · ${m.source} · ${date}`);
        }
        push("sys", "(/memory rm <id> deletes one)");
        break;
      }

      case "voice":
        toggleVoice();
        push("sys", `voice replies ${voiceOn ? "off" : "on"}.`);
        break;

      case "clear": {
        tts.current.cancel();
        setSpeaking(0);
        sessionId.current = crypto.randomUUID();
        setLines([]);
        push("sys", "session cleared — short-term context gone, long-term memory intact.");
        break;
      }

      default:
        push("err", `[err] unknown command: /${cmd} — try /help`);
    }
  };

  /** Returns whether the message was accepted (false = busy/boot — caller keeps it). */
  const send = async (raw: string): Promise<boolean> => {
    const msg = raw.trim();
    if (!msg || busy.current || phase === "boot") return false;
    busy.current = true;
    let streamer: SentenceStreamer | null = null;
    let settled = false;
    let acc = "";
    try {
      push("user", `you@echo:~$ ${msg}`);

      if (msg.startsWith("/")) {
        await runCommand(msg);
        settled = true;
        return true;
      }

      // Voice out: speak sentence-by-sentence AS tokens stream, so the reply is
      // audible before it's finished. Latency honest — no wait-for-full-text.
      activeStreamer.current?.stop();
      tts.current.cancel();
      setSpeaking(0);
      streamer = voiceOn
        ? new SentenceStreamer((sentence) =>
            tts.current.speak(sentence, {
              onStart: () => setSpeaking((c) => c + 1),
              onDone: () => setSpeaking((c) => Math.max(0, c - 1)),
            }),
          )
        : null;
      activeStreamer.current = streamer;

      setPhase("thinking");
      await chat(sessionId.current, msg, {
        onMeta: ({ recalled }) => {
          if (recalled.length > 0) {
            const top = recalled[0]!;
            push(
              "mem",
              `[mem?] recalled ${recalled.length} fact${recalled.length > 1 ? "s" : ""} · top: "${top.fact}" (${(top.score * 100).toFixed(0)}%)`,
            );
          }
        },
        onToken: (t) => {
          acc += t;
          streamer?.push(t);
          setPhase("streaming");
          setStreamText(acc);
        },
        onDone: ({ remembered }) => {
          settled = true;
          streamer?.flush();
          if (acc) push("echo", `echo> ${acc}`);
          for (const m of remembered) push("mem", `[mem+] stored: "${m.fact}"`);
          setStreamText(null);
          setPhase("idle");
          getStatus().then(setStatus).catch(() => {});
        },
        onError: (message) => {
          settled = true;
          streamer?.stop(); // don't speak a broken tail
          if (acc) push("echo", `echo> ${acc}`);
          push("err", `[err] ${message}`);
          setStreamText(null);
          setPhase("idle");
        },
      });
      return true;
    } finally {
      // Whatever happened above — an exception, or a stream that ended without
      // a done/error event — the terminal must never wedge: input always returns.
      if (!settled) {
        streamer?.stop();
        if (acc) push("echo", `echo> ${acc}`);
        push("err", "[err] stream ended unexpectedly");
        setStreamText(null);
        setPhase("idle");
      }
      busy.current = false;
    }
  };

  const submit = () => {
    const msg = input;
    setInput("");
    void send(msg).then((ok) => {
      if (!ok && msg.trim()) setInput(msg); // rejected while busy — restore, never destroy
    });
  };

  const state = listening
    ? "listening"
    : phase === "thinking"
      ? "thinking"
      : phase === "streaming"
        ? speaking > 0
          ? "speaking"
          : "streaming"
        : speaking > 0
          ? "speaking"
          : "idle";

  return (
    <div className="crt term" onClick={() => inputRef.current?.focus()}>
      <div className="sweep" aria-hidden="true" />

      <header className="bar">
        <span className="bar-title">ECHO</span>
        <span className={`bar-state st-${state}`} aria-live="polite">
          ▸ {state}
        </span>
        <span className="bar-right">
          <button
            className={`bar-btn ${listening ? "on-amber" : ""}`}
            onClick={mic}
            disabled={!stt.current.available() || phase !== "idle"}
            title={stt.current.available() ? "push to talk (Esc cancels)" : "SpeechRecognition unavailable"}
          >
            ◉ mic
          </button>
          <button className={`bar-btn ${voiceOn ? "on-green" : ""}`} onClick={toggleVoice} title="spoken replies">
            voice:{voiceOn ? "on" : "off"}
          </button>
          <span className="bar-dim">mem:{status?.memories ?? "–"}</span>
          <span className={status?.hasKey ? "bar-ok" : "bar-warn"}>
            {status ? (status.hasKey ? `● ${status.model}` : "○ NO KEY") : "○ backend?"}
          </span>
        </span>
      </header>

      <div className="scroll" ref={scrollRef}>
        {lines.map((l) => (
          <div key={l.id} className={`line ${l.kind}`}>
            {l.text}
          </div>
        ))}

        {streamText !== null && (
          <div className="line echo">
            echo&gt; {streamText}
            <span className="cursor" aria-hidden="true" />
          </div>
        )}

        {phase === "thinking" && (
          <div className="line mem" aria-live="polite">
            [{SPINNER[spin]}] retrieving memory · thinking
          </div>
        )}

        {listening && (
          <div className="line mem">
            [◉ listening] {interim || "…"}
            <span className="cursor" aria-hidden="true" />
          </div>
        )}

        {(phase === "idle" || phase === "boot") && !listening && (
          <div className="inputrow">
            <span className="prompt">you@echo:~$&nbsp;</span>
            <input
              ref={inputRef}
              className="input"
              value={input}
              disabled={phase === "boot"}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submit()}
              autoFocus
              spellCheck={false}
              autoComplete="off"
              aria-label="message ECHO"
              style={{ width: `${Math.max(1, input.length + 1)}ch` }}
            />
            <span className="cursor" aria-hidden="true" />
          </div>
        )}
      </div>
    </div>
  );
}
