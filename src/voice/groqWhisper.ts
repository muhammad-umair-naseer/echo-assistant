/**
 * STT via Groq Whisper — the upgrade path made real. Records mic audio locally
 * with MediaRecorder, POSTs it to our backend, which forwards to Groq's
 * whisper-large-v3 on the SAME key as chat. No Google speech service involved
 * (Chrome's built-in recognizer streams audio to Google and fails silently on
 * some networks — the failure that motivated this provider).
 *
 * Semantics differ from Web Speech: this is batch, not streaming — click mic to
 * start, click again (or auto-stop at 30s) to transcribe. No live interims; we
 * report a "transcribing" partial while Whisper runs.
 */
import type { SttProvider } from "./types.ts";

const MAX_MS = 30_000; // hard cap a forgotten hot mic

export class GroqWhisperStt implements SttProvider {
  private rec: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private timer = 0;
  private cancelled = false;

  available(): boolean {
    return typeof MediaRecorder !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
  }

  start(cb: {
    onPartial: (t: string) => void;
    onFinal: (t: string) => void;
    onEnd: () => void;
    onError?: (code: string) => void;
  }): void {
    this.cancelled = false;
    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((stream) => {
        if (this.cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          cb.onEnd();
          return;
        }
        this.stream = stream;
        const rec = new MediaRecorder(stream, { mimeType: pickMime() });
        this.rec = rec;
        const chunks: Blob[] = [];
        rec.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data);
        rec.onstop = async () => {
          stream.getTracks().forEach((t) => t.stop());
          this.stream = null;
          this.rec = null;
          clearTimeout(this.timer);
          if (this.cancelled) return cb.onEnd();
          try {
            cb.onPartial("⋯ transcribing");
            const blob = new Blob(chunks, { type: rec.mimeType });
            const res = await fetch("/api/transcribe", {
              method: "POST",
              headers: { "content-type": rec.mimeType },
              body: blob,
            });
            const json = (await res.json().catch(() => ({}))) as { text?: string; error?: string };
            if (!res.ok) cb.onError?.(json.error ?? `transcribe http ${res.status}`);
            else if (json.text) cb.onFinal(json.text);
            else cb.onError?.("heard nothing — check the mic input device");
          } catch (err) {
            cb.onError?.(`transcribe failed: ${(err as Error).message}`);
          } finally {
            cb.onEnd();
          }
        };
        rec.start();
        this.timer = window.setTimeout(() => this.stop(), MAX_MS);
      })
      .catch((err: Error) => {
        cb.onError?.(err.name === "NotAllowedError" ? "microphone permission denied" : `mic: ${err.message}`);
        cb.onEnd();
      });
  }

  stop(): void {
    if (this.rec && this.rec.state !== "inactive") this.rec.stop();
  }

  cancel(): void {
    this.cancelled = true;
    clearTimeout(this.timer);
    if (this.rec && this.rec.state !== "inactive") this.rec.stop();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }
}

function pickMime(): string {
  for (const m of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return "";
}
