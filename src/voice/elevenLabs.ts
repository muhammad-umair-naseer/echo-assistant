/**
 * ElevenLabs TTS behind the same TtsProvider seam. Each sentence is fetched as
 * mp3 from our backend (which holds the key) and played through a FIFO audio
 * queue, so sentence-streamed speech keeps its ordering. Fetches run eagerly
 * (parallel) while playback stays serial — sentence 2 is usually downloaded
 * before sentence 1 finishes speaking.
 */
import type { TtsProvider } from "./types.ts";

interface QueueItem {
  audio: Promise<Blob | null>;
  cb?: { onStart?: () => void; onDone?: () => void };
}

export class ElevenLabsTts implements TtsProvider {
  private queue: QueueItem[] = [];
  private current: HTMLAudioElement | null = null;
  private playing = false;
  private generation = 0; // bumped on cancel — orphans in-flight work

  available(): boolean {
    return typeof Audio !== "undefined";
  }

  speak(text: string, cb?: { onStart?: () => void; onDone?: () => void }): void {
    const audio = fetch("/api/tts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    })
      .then((r) => (r.ok ? r.blob() : null))
      .catch(() => null);
    this.queue.push({ audio, cb });
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.playing) return;
    this.playing = true;
    const gen = this.generation;
    while (this.queue.length > 0 && gen === this.generation) {
      const item = this.queue.shift()!;
      const blob = await item.audio;
      if (gen !== this.generation) {
        item.cb?.onDone?.();
        break;
      }
      if (!blob) {
        item.cb?.onDone?.(); // fetch failed — skip, keep the queue moving
        continue;
      }
      const url = URL.createObjectURL(blob);
      const el = new Audio(url);
      this.current = el;
      item.cb?.onStart?.();
      await new Promise<void>((resolve) => {
        el.onended = () => resolve();
        el.onerror = () => resolve();
        void el.play().catch(() => resolve());
      });
      URL.revokeObjectURL(url);
      this.current = null;
      item.cb?.onDone?.();
    }
    this.playing = false;
  }

  cancel(): void {
    this.generation++;
    this.queue = [];
    if (this.current) {
      this.current.pause();
      this.current.src = "";
      this.current = null;
    }
    this.playing = false;
  }
}
