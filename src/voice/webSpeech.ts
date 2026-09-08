/**
 * Browser-native providers — zero keys, works today. STT via the (webkit)
 * SpeechRecognition API, TTS via speechSynthesis. Both live behind the
 * SttProvider/TtsProvider interfaces so Whisper/ElevenLabs can replace them
 * without touching the terminal.
 */
import type { SttProvider, TtsProvider } from "./types.ts";

type RecognitionCtor = new () => SpeechRecognition;

interface SpeechRecognition extends EventTarget {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((ev: { results: ArrayLike<{ 0: { transcript: string }; isFinal: boolean }> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((ev: { error: string }) => void) | null;
}

const Recognition: RecognitionCtor | undefined =
  (globalThis as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor })
    .SpeechRecognition ??
  (globalThis as { webkitSpeechRecognition?: RecognitionCtor }).webkitSpeechRecognition;

export class WebSpeechStt implements SttProvider {
  private rec: SpeechRecognition | null = null;

  available(): boolean {
    return !!Recognition;
  }

  start(cb: {
    onPartial: (t: string) => void;
    onFinal: (t: string) => void;
    onEnd: () => void;
    onError?: (code: string) => void;
  }): void {
    if (!Recognition) return cb.onEnd();
    const rec = new Recognition();
    this.rec = rec;
    rec.lang = "en-US";
    rec.interimResults = true;
    rec.continuous = false; // push-to-talk: one utterance per activation
    let finalText = "";
    rec.onresult = (ev) => {
      // Each event carries the FULL results list — rebuild the transcript from
      // scratch every time (appending across events duplicates finals).
      let interim = "";
      let final = "";
      for (let i = 0; i < ev.results.length; i++) {
        const r = ev.results[i]!;
        if (r.isFinal) final += r[0].transcript;
        else interim += r[0].transcript;
      }
      finalText = final;
      if (final || interim) cb.onPartial(`${final}${interim}`);
    };
    rec.onerror = (ev) => {
      // 'no-speech' (silence timeout) and 'aborted' (our cancel) are normal;
      // everything else the user must SEE — Chrome STT is a Google-server call
      // and can fail on network alone while the mic itself works fine.
      if (ev.error !== "no-speech" && ev.error !== "aborted") cb.onError?.(ev.error);
    };
    rec.onend = () => {
      this.rec = null;
      if (finalText.trim()) cb.onFinal(finalText.trim());
      cb.onEnd();
    };
    rec.start();
  }

  stop(): void {
    this.rec?.stop(); // lets pending audio finalize, then onend fires
  }

  cancel(): void {
    this.rec?.abort();
    this.rec = null;
  }
}

export class WebSpeechTts implements TtsProvider {
  private active = 0;

  available(): boolean {
    return typeof speechSynthesis !== "undefined";
  }

  speak(text: string, cb?: { onStart?: () => void; onDone?: () => void }): void {
    if (!this.available()) {
      cb?.onDone?.();
      return;
    }
    const u = new SpeechSynthesisUtterance(text);
    u.rate = 1.06; // a touch brisk — terminal, not audiobook
    u.onstart = () => {
      this.active++;
      cb?.onStart?.();
    };
    const done = () => {
      this.active = Math.max(0, this.active - 1);
      cb?.onDone?.();
    };
    u.onend = done;
    u.onerror = done;
    speechSynthesis.speak(u); // utterances queue natively, in order
  }

  cancel(): void {
    if (this.available()) speechSynthesis.cancel();
    this.active = 0;
  }
}
