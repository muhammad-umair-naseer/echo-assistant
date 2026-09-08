import { useEffect, useRef, useState } from "react";
import { useEcho, type EchoState, type Msg } from "../useEcho.ts";
import type { MemoryItem } from "../api.ts";

/* ================= splash — the one orchestrated moment =================== */

const reducedMotion = () =>
  typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

const WORD = "JARVIS";

function Splash({
  ready,
  statusLine,
  memLine,
  voiceLine,
  onDone,
}: {
  ready: boolean;
  statusLine: string;
  memLine: string;
  voiceLine: string;
  onDone: () => void;
}) {
  const [step, setStep] = useState(0); // 0..4 boot steps
  const [online, setOnline] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const readyRef = useRef(ready);
  readyRef.current = ready;

  useEffect(() => {
    if (reducedMotion()) {
      onDone();
      return;
    }
    let dead = false;
    // ?splash=slow stretches the timeline 6x — for demos/recording (dev aid).
    const slow = new URLSearchParams(location.search).get("splash") === "slow" ? 6 : 1;
    const t0 = performance.now();
    const finish = () => {
      if (dead) return;
      setOnline(true);
      setTimeout(() => setLeaving(true), 620 * slow);
      setTimeout(() => !dead && onDone(), 1080 * slow);
    };
    const tick = setInterval(() => {
      setStep((s) => {
        // step 1 (interface) is free; the data steps gate on REAL readiness —
        // the bar only fills with the truth. After 6s, proceed with whatever
        // the status line says (backend-down reads as such).
        const waitedTooLong = performance.now() - t0 > 6000 * slow;
        if (s >= 1 && !readyRef.current && !waitedTooLong) return s;
        const next = Math.min(4, s + 1);
        if (next === 4) {
          clearInterval(tick);
          finish();
        }
        return next;
      });
    }, 340 * slow);
    const skip = () => {
      clearInterval(tick);
      setLeaving(true);
      setTimeout(() => !dead && onDone(), 220);
    };
    window.addEventListener("keydown", skip, { once: true });
    window.addEventListener("pointerdown", skip, { once: true });
    return () => {
      dead = true;
      clearInterval(tick);
      window.removeEventListener("keydown", skip);
      window.removeEventListener("pointerdown", skip);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const steps = [
    "initializing interface",
    `linking neural core ......... ${statusLine}`,
    `memory bank ................. ${memLine}`,
    `voice io .................... ${voiceLine}`,
  ];

  return (
    <div className={`splash ${leaving ? "leave" : ""}`} aria-hidden="true">
      <div className="reactor" aria-hidden="true">
        <span className="arc a1" />
        <span className="arc a2" />
        <span className="arc a3" />
      </div>
      <div className="splash-word" aria-hidden="true">
        {WORD.split("").map((ch, i) => (
          <span key={i} className="lt">
            <span style={{ ["--d" as string]: `${i * 65}ms` }}>{ch}</span>
          </span>
        ))}
      </div>
      <div className="splash-tag">personal assistant · long-term memory · voice</div>
      <div className="splash-steps">
        {steps.slice(0, step).map((s, i) => (
          <div key={i} className="splash-step">
            <span className="step-glyph">▸</span> {s}
          </div>
        ))}
      </div>
      <div className="splash-progress">
        <span style={{ transform: `scaleX(${step / 4})` }} />
      </div>
      <div className={`splash-online ${online ? "show" : ""}`}>● ONLINE</div>
      <div className="splash-skip">press any key to skip</div>
    </div>
  );
}

/* ================= voice orb ============================================== */

function VoiceOrb({ state, onClick, disabled }: { state: EchoState; onClick: () => void; disabled: boolean }) {
  return (
    <button className={`orb st-${state}`} onClick={onClick} disabled={disabled} aria-label="push to talk">
      <span className="orb-ring r1" />
      <span className="orb-ring r2" />
      <span className="orb-core">
        <span className="orb-bars" aria-hidden="true">
          <i />
          <i />
          <i />
          <i />
          <i />
        </span>
      </span>
      <span className="orb-label">{state === "idle" ? "talk" : state}</span>
    </button>
  );
}

/* ================= memory panel =========================================== */

function MemoryPanel({
  memories,
  freshIds,
  flashIds,
  onDelete,
}: {
  memories: MemoryItem[];
  freshIds: number[];
  flashIds: number[];
  onDelete: (id: number) => void;
}) {
  return (
    <section className="panel mem-panel">
      <header className="panel-head">
        <span>MEMORY BANK</span>
        <span className="panel-count">{memories.length}</span>
      </header>
      <div className="mem-list">
        {memories.length === 0 && <div className="mem-empty">empty — tell me something about yourself.</div>}
        {[...memories].reverse().map((m) => (
          <article
            key={m.id}
            className={`mem-card ${freshIds.includes(m.id) ? "fresh" : ""} ${flashIds.includes(m.id) ? "flash" : ""}`}
            id={`mem-${m.id}`}
          >
            <p>{m.fact}</p>
            <footer>
              <span>
                #{m.id} · {m.source} · {m.created_at.slice(0, 10)}
              </span>
              <button className="mem-del" onClick={() => onDelete(m.id)} title="forget this" aria-label={`delete memory ${m.id}`}>
                ✕
              </button>
            </footer>
          </article>
        ))}
      </div>
    </section>
  );
}

/* ================= chat =================================================== */

const ROLE_GLYPH: Record<string, string> = { user: "❯", echo: "▮", sys: "·", err: "!" };

function MessageCard({ m, onChipClick }: { m: Msg; onChipClick: (ids: number[]) => void }) {
  return (
    <article className={`msg msg-${m.role}`}>
      <span className="msg-glyph" aria-hidden="true">
        {ROLE_GLYPH[m.role]}
      </span>
      <div className="msg-body">
        {m.recalled && m.recalled.length > 0 && (
          <button
            className="chip chip-recall"
            onClick={() => onChipClick(m.recalled!.map((r) => r.id))}
            title="show these in the memory bank"
          >
            ⟲ recalled {m.recalled.length}: “{m.recalled[0]!.fact.slice(0, 42)}
            {m.recalled[0]!.fact.length > 42 ? "…" : ""}” {(m.recalled[0]!.score * 100).toFixed(0)}%
          </button>
        )}
        <p className="msg-text">
          {m.text}
          {m.streaming && <span className="cursor" aria-hidden="true" />}
        </p>
        {m.remembered && m.remembered.length > 0 && (
          <div className="chip-row">
            {m.remembered.map((r) => (
              <button key={r.id} className="chip chip-stored" onClick={() => onChipClick([r.id])} title="show in memory bank">
                +mem “{r.fact.slice(0, 36)}
                {r.fact.length > 36 ? "…" : ""}”
              </button>
            ))}
          </div>
        )}
      </div>
    </article>
  );
}

/* ================= composer (slash menu + chips) ========================== */

const COMMANDS = [
  { cmd: "/memory", hint: "refresh the memory bank" },
  { cmd: "/memory rm ", hint: "forget one memory by id" },
  { cmd: "/voice", hint: "toggle spoken replies" },
  { cmd: "/clear", hint: "new session (memories survive)" },
  { cmd: "/help", hint: "command list" },
];

const SUGGESTIONS = ["what do you remember about me?", "my name is …", "I'm building …"];

/* ================= the deck =============================================== */

export function Deck() {
  const echo = useEcho();
  const [booted, setBooted] = useState(false);
  const [input, setInput] = useState("");
  const [flashIds, setFlashIds] = useState<number[]>([]);
  const feedRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // auto-scroll the feed
  useEffect(() => {
    const el = feedRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [echo.messages, echo.interim, echo.state]);

  // memory-chip click → flash + scroll the sidebar card
  const flash = (ids: number[]) => {
    setFlashIds(ids);
    const first = ids[0];
    if (first != null) document.getElementById(`mem-${first}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    setTimeout(() => setFlashIds([]), 1200);
  };

  const submit = () => {
    const msg = input;
    setInput("");
    void echo.send(msg).then((ok) => {
      if (!ok && msg.trim()) setInput(msg);
    });
  };

  const showSlash = input.startsWith("/");
  const online = echo.status?.hasKey;

  return (
    <div className="crt deck-root">
      <div className="sweep" aria-hidden="true" />
      {!booted && (
        <Splash
          ready={echo.statusSettled}
          statusLine={echo.status ? (online ? echo.status.model : "NO KEY — memory still on") : "backend unreachable"}
          memLine={echo.status ? `${echo.status.memories} facts indexed` : "–"}
          voiceLine={echo.sttAvailable ? `stt: ${echo.sttName}` : "unavailable"}
          onDone={() => setBooted(true)}
        />
      )}

      <div className={`deck ${booted ? "in" : ""}`}>
        <header className="deck-bar" style={{ ["--i" as string]: 0 }}>
          <span className="logo">
            JARVIS<span className="logo-cursor">_</span>
          </span>
          <span className={`pill ${online ? "pill-ok" : "pill-warn"}`}>
            {echo.status ? (online ? `● ${echo.status.model}` : "○ NO KEY") : "○ backend?"}
          </span>
          <span className="pill pill-dim">stt: {echo.sttName}</span>
          <span className="bar-space" />
          <span className={`pill state-pill st-${echo.state}`} aria-live="polite">
            ▸ {echo.state}
          </span>
          <button className={`pill pill-btn ${echo.voiceOn ? "pill-ok" : ""}`} onClick={echo.toggleVoice}>
            voice:{echo.voiceOn ? "on" : "off"}
          </button>
        </header>

        <main className="deck-main">
          <section className="panel chat-panel" style={{ ["--i" as string]: 1 }}>
            <div className="feed" ref={feedRef}>
              {echo.messages.length === 0 && (
                <div className="hello">
                  <div className="hello-title">I remember what you tell me.</div>
                  <div className="hello-sub">
                    across sessions, restarts, and days — facts are embedded, stored, and retrieved by meaning.
                  </div>
                  <div className="chip-row">
                    {SUGGESTIONS.map((s) => (
                      <button key={s} className="chip" onClick={() => (s.endsWith("…") ? setInput(s.slice(0, -1)) : void echo.send(s))}>
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {echo.messages.map((m) => (
                <MessageCard key={m.id} m={m} onChipClick={flash} />
              ))}
              {echo.listening && (
                <div className="msg msg-user listening-row">
                  <span className="msg-glyph">◉</span>
                  <p className="msg-text">
                    {echo.interim || "listening…"}
                    <span className="cursor" aria-hidden="true" />
                  </p>
                </div>
              )}
              {echo.state === "thinking" && <div className="thinking-row">retrieving memory · thinking</div>}
            </div>

            <div className="composer-wrap">
              {showSlash && (
                <div className="slash-menu">
                  {COMMANDS.filter((c) => c.cmd.startsWith(input) || input.startsWith(c.cmd.trim())).map((c) => (
                    <button
                      key={c.cmd}
                      className="slash-item"
                      onClick={() => {
                        if (c.cmd.endsWith(" ")) {
                          setInput(c.cmd);
                          inputRef.current?.focus();
                        } else {
                          setInput("");
                          void echo.send(c.cmd);
                        }
                      }}
                    >
                      <b>{c.cmd}</b>
                      <span>{c.hint}</span>
                    </button>
                  ))}
                </div>
              )}
              <div className="composer">
                <span className="composer-prompt">❯</span>
                <input
                  ref={inputRef}
                  className="composer-input"
                  value={input}
                  placeholder="say something — or type / for commands"
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && submit()}
                  spellCheck={false}
                  autoComplete="off"
                  aria-label="message JARVIS"
                  autoFocus
                />
                <button
                  className={`comp-btn mic-btn ${echo.listening ? "live" : ""}`}
                  onClick={echo.mic}
                  disabled={!echo.sttAvailable || echo.phase !== "idle"}
                  title={echo.listening ? "click to send" : "push to talk"}
                >
                  ◉
                </button>
                <button className="comp-btn send-btn" onClick={submit} disabled={!input.trim()} title="send">
                  ↵
                </button>
              </div>
            </div>
          </section>

          <aside className="deck-aside">
            <section className="panel orb-panel" style={{ ["--i" as string]: 2 }}>
              <VoiceOrb state={echo.state} onClick={echo.mic} disabled={!echo.sttAvailable || echo.phase !== "idle"} />
            </section>
            <section className="panel status-panel" style={{ ["--i" as string]: 3 }}>
              <header className="panel-head">SYSTEM</header>
              <dl className="status-rows">
                <div>
                  <dt>llm</dt>
                  <dd className={online ? "ok" : "warn"}>{echo.status ? (online ? "online" : "no key") : "down"}</dd>
                </div>
                <div>
                  <dt>stt</dt>
                  <dd>{echo.sttName}</dd>
                </div>
                <div>
                  <dt>memories</dt>
                  <dd>{echo.status?.memories ?? "–"}</dd>
                </div>
                <div>
                  <dt>tts</dt>
                  <dd>{echo.ttsName} · {echo.voiceOn ? (echo.speaking ? "speaking" : "armed") : "off"}</dd>
                </div>
              </dl>
            </section>
            <div style={{ ["--i" as string]: 4, display: "contents" }}>
              <MemoryPanel
                memories={echo.memories}
                freshIds={echo.recentMemIds}
                flashIds={flashIds}
                onDelete={(id) => void echo.deleteMemory(id)}
              />
            </div>
          </aside>
        </main>
      </div>
    </div>
  );
}
