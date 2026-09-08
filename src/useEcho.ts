/**
 * The assistant's client-side brain, UI-free: chat streaming, the memory loop
 * events, voice in/out (Whisper via Groq when keyed, Web Speech fallback),
 * sentence-streamed TTS, commands, and the busy/phase state machine. The GUI
 * renders this hook; it renders nothing itself.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  chat,
  getStatus,
  listMemories,
  removeMemory,
  type MemoryItem,
  type Recalled,
  type Remembered,
  type Status,
} from "./api.ts";
import { SentenceStreamer } from "./voice/sentences.ts";
import { WebSpeechStt, WebSpeechTts } from "./voice/webSpeech.ts";
import { GroqWhisperStt } from "./voice/groqWhisper.ts";

export type Role = "user" | "echo" | "sys" | "err";
export interface Msg {
  id: number;
  role: Role;
  text: string;
  recalled?: Recalled[];
  remembered?: Remembered[];
  streaming?: boolean;
}

export type EchoState = "idle" | "listening" | "transcribing" | "thinking" | "streaming" | "speaking";

let nextId = 1;

export function useEcho() {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [status, setStatus] = useState<Status | null>(null);
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [recentMemIds, setRecentMemIds] = useState<number[]>([]); // for highlight animation
  const [phase, setPhase] = useState<"idle" | "thinking" | "streaming">("idle");
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [speaking, setSpeaking] = useState(0);
  const [voiceOn, setVoiceOn] = useState(() => localStorage.getItem("echo-voice") === "1");
  const [statusSettled, setStatusSettled] = useState(false); // the splash gates on real readiness

  const sessionId = useRef<string>(crypto.randomUUID());
  const webStt = useRef(new WebSpeechStt());
  const whisper = useRef(new GroqWhisperStt());
  const tts = useRef(new WebSpeechTts());
  const busy = useRef(false);
  const activeStreamer = useRef<SentenceStreamer | null>(null);

  const push = useCallback((m: Omit<Msg, "id">): number => {
    const id = nextId++;
    setMessages((ms) => [...ms, { ...m, id }]);
    return id;
  }, []);

  const patch = useCallback((id: number, up: Partial<Msg>) => {
    setMessages((ms) => ms.map((m) => (m.id === id ? { ...m, ...up } : m)));
  }, []);

  const refreshStatus = useCallback(() => {
    getStatus()
      .then(setStatus)
      .catch(() => setStatus(null))
      .finally(() => setStatusSettled(true));
  }, []);
  const refreshMemories = useCallback(() => {
    listMemories().then(setMemories).catch(() => {});
  }, []);

  useEffect(() => {
    refreshStatus();
    refreshMemories();
  }, [refreshStatus, refreshMemories]);

  // ---- voice plumbing -------------------------------------------------------
  const sttEngine = useCallback(
    () => (status?.hasKey && whisper.current.available() ? whisper.current : webStt.current),
    [status],
  );
  const sttAvailable = whisper.current.available() || webStt.current.available();
  const sttName = status?.hasKey && whisper.current.available() ? "whisper·groq" : "web speech";

  const silenceAll = useCallback(() => {
    activeStreamer.current?.stop();
    tts.current.cancel();
    setSpeaking(0);
  }, []);

  const cancelVoice = useCallback(() => {
    webStt.current.cancel();
    whisper.current.cancel();
    setListening(false);
    setInterim("");
    silenceAll();
  }, [silenceAll]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && cancelVoice();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cancelVoice]);

  const toggleVoice = useCallback(() => {
    setVoiceOn((v) => {
      const next = !v;
      localStorage.setItem("echo-voice", next ? "1" : "0");
      if (!next) silenceAll();
      return next;
    });
  }, [silenceAll]);

  // ---- commands -------------------------------------------------------------
  const runCommand = async (raw: string) => {
    const [cmd, sub, ...rest] = raw.slice(1).trim().split(/\s+/);
    switch ((cmd ?? "").toLowerCase()) {
      case "help":
        push({
          role: "sys",
          text: "commands: /memory (list) · /memory rm <id> · /voice (spoken replies) · /clear (new session; memories survive) · /help — mic button to talk, Esc cancels voice",
        });
        break;
      case "memory": {
        if (sub === "rm" && rest[0]) {
          const id = Number(rest[0]);
          const ok = Number.isInteger(id) && (await removeMemory(id).catch(() => false));
          push({ role: ok ? "sys" : "err", text: ok ? `deleted memory #${id}` : `no memory #${rest[0]}` });
          refreshMemories();
          refreshStatus();
          break;
        }
        refreshMemories();
        push({ role: "sys", text: "memory bank refreshed — it's the panel on the right." });
        break;
      }
      case "voice":
        toggleVoice();
        push({ role: "sys", text: `voice replies ${voiceOn ? "off" : "on"}.` });
        break;
      case "clear":
        silenceAll();
        sessionId.current = crypto.randomUUID();
        setMessages([]);
        push({ role: "sys", text: "session cleared — short-term context gone, long-term memory intact." });
        break;
      default:
        push({ role: "err", text: `unknown command: /${cmd} — try /help` });
    }
  };

  // ---- send -----------------------------------------------------------------
  const send = useCallback(
    async (raw: string): Promise<boolean> => {
      const msg = raw.trim();
      if (!msg || busy.current) return false;
      busy.current = true;
      let streamer: SentenceStreamer | null = null;
      let settled = false;
      let echoId = -1;
      let acc = "";
      try {
        push({ role: "user", text: msg });
        if (msg.startsWith("/")) {
          await runCommand(msg);
          settled = true;
          return true;
        }

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
            echoId = push({ role: "echo", text: "", streaming: true, recalled });
          },
          onToken: (t) => {
            acc += t;
            streamer?.push(t);
            setPhase("streaming");
            if (echoId >= 0) patch(echoId, { text: acc });
          },
          onDone: ({ remembered }) => {
            settled = true;
            streamer?.flush();
            if (echoId >= 0) patch(echoId, { text: acc, streaming: false, remembered });
            setPhase("idle");
            if (remembered.length > 0) {
              setRecentMemIds(remembered.map((m) => m.id));
              refreshMemories();
            }
            refreshStatus();
          },
          onError: (message) => {
            settled = true;
            streamer?.stop();
            if (echoId >= 0) patch(echoId, { text: acc, streaming: false });
            push({ role: "err", text: message });
            setPhase("idle");
          },
        });
        return true;
      } finally {
        if (!settled) {
          streamer?.stop();
          if (echoId >= 0) patch(echoId, { text: acc, streaming: false });
          push({ role: "err", text: "stream ended unexpectedly" });
          setPhase("idle");
        }
        busy.current = false;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [voiceOn, push, patch, refreshMemories, refreshStatus],
  );

  // ---- mic ------------------------------------------------------------------
  const mic = useCallback(() => {
    const engine = sttEngine();
    if (!engine.available() || phase !== "idle") return;
    if (listening) {
      engine.stop();
      return;
    }
    silenceAll();
    setListening(true);
    setInterim("");
    engine.start({
      onPartial: (t) => setInterim(t),
      onFinal: (t) =>
        void send(t).then((ok) => {
          if (!ok) push({ role: "sys", text: `(busy — voice input dropped: "${t}")` });
        }),
      onError: (code) => {
        const why: Record<string, string> = {
          network: "speech service unreachable — check network/VPN",
          "no-speech": "heard nothing — check the mic input device / level",
          "not-allowed": "microphone permission denied — allow it for this site",
          "audio-capture": "no usable microphone found",
        };
        push({ role: "err", text: `voice: ${why[code] ?? code}` });
      },
      onEnd: () => {
        setListening(false);
        setInterim("");
      },
    });
  }, [sttEngine, phase, listening, silenceAll, send, push]);

  const deleteMemory = useCallback(
    async (id: number) => {
      const ok = await removeMemory(id).catch(() => false);
      if (ok) {
        setMemories((ms) => ms.filter((m) => m.id !== id));
        refreshStatus();
      }
      return ok;
    },
    [refreshStatus],
  );

  const state: EchoState = listening
    ? interim === "⋯ transcribing"
      ? "transcribing"
      : "listening"
    : phase === "thinking"
      ? "thinking"
      : phase === "streaming"
        ? "streaming"
        : speaking > 0
          ? "speaking"
          : "idle";

  return {
    messages,
    status,
    statusSettled,
    memories,
    recentMemIds,
    state,
    phase,
    listening,
    interim,
    speaking: speaking > 0,
    voiceOn,
    sttAvailable,
    sttName,
    send,
    mic,
    toggleVoice,
    deleteMemory,
    cancelVoice,
  };
}
