import { useCallback, useEffect, useRef, useState } from "react";
import { chat, getStatus, type Status } from "./api.ts";

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

  const sessionId = useRef<string>(crypto.randomUUID());
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

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
      let i = 0;
      const tick = setInterval(() => {
        i = Math.min(text.length, i + 3); // 3 chars per tick — mechanical, quick
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
      await typeLine("sys", "ECHO ▮ personal assistant kernel v0.1.0");
      await typeLine("sys", `memory core ............ online (${st?.memories ?? 0} facts indexed)`);
      if (st?.hasKey) {
        await typeLine("sys", `llm link ............... ${st.model} via groq · online`);
      } else {
        await typeLine("err", "llm link ............... OFFLINE — add GROQ_API_KEY to backend/.env");
        await typeLine("sys", "memory systems operate without the key. facts you state are stored.");
      }
      await typeLine("sys", "READY. type a message. (/commands arrive in phase 3)");
      if (!cancelled) setPhase("idle");
    })();
    return () => {
      cancelled = true;
    };
  }, [typeLine]);

  // thinking spinner (JS interval only while active — text frames, no tween)
  useEffect(() => {
    if (phase !== "thinking") return;
    const t = setInterval(() => setSpin((s) => (s + 1) % SPINNER.length), 120);
    return () => clearInterval(t);
  }, [phase]);

  // keep scrolled to the newest line
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines, streamText, phase]);

  const submit = async () => {
    const msg = input.trim();
    if (!msg || phase === "thinking" || phase === "streaming" || phase === "boot") return;
    setInput("");
    push("user", `you@echo:~$ ${msg}`);

    if (msg.startsWith("/")) {
      push("sys", "command palette ships in phase 3 — for now, just talk to it.");
      return;
    }

    setPhase("thinking");
    let acc = "";
    await chat(sessionId.current, msg, {
      onMeta: ({ recalled }) => {
        if (recalled.length > 0) {
          const top = recalled[0];
          push(
            "mem",
            `[mem?] recalled ${recalled.length} fact${recalled.length > 1 ? "s" : ""} · top: "${top.fact}" (${(top.score * 100).toFixed(0)}%)`,
          );
        }
      },
      onToken: (t) => {
        acc += t;
        setPhase("streaming");
        setStreamText(acc);
      },
      onDone: ({ remembered }) => {
        if (acc) push("echo", `echo> ${acc}`);
        for (const m of remembered) push("mem", `[mem+] stored: "${m.fact}"`);
        setStreamText(null);
        setPhase("idle");
        getStatus().then(setStatus).catch(() => {});
      },
      onError: (message) => {
        if (acc) push("echo", `echo> ${acc}`);
        push("err", `[err] ${message}`);
        setStreamText(null);
        setPhase("idle");
      },
    });
  };

  return (
    <div className="crt term" onClick={() => inputRef.current?.focus()}>
      <div className="sweep" aria-hidden="true" />

      <header className="bar">
        <span className="bar-title">ECHO</span>
        <span className="bar-dim">mem:{status?.memories ?? "–"}</span>
        <span className={status?.hasKey ? "bar-ok" : "bar-warn"}>
          {status ? (status.hasKey ? `● ${status.model}` : "○ NO KEY") : "○ backend?"}
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

        {(phase === "idle" || phase === "boot") && (
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
