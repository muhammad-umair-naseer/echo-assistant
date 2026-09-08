/**
 * The audio layer's seam. The app talks ONLY to these interfaces; Web Speech
 * implements them today, and a higher-quality provider (Groq Whisper for STT,
 * ElevenLabs for TTS) drops in behind the same contract later — no UI changes.
 */

export interface SttProvider {
  /** Is this provider usable in the current browser/environment? */
  available(): boolean;
  /**
   * Start capturing. `onPartial` fires with live interim text (may revise),
   * `onFinal` once with the settled transcript, `onEnd` when capture stops
   * (final, cancel, error, or silence timeout).
   */
  start(cb: { onPartial: (text: string) => void; onFinal: (text: string) => void; onEnd: () => void }): void;
  /** Stop capturing; a final result may still fire for audio already heard. */
  stop(): void;
  cancel(): void;
}

export interface TtsProvider {
  available(): boolean;
  /** Queue one chunk (a sentence) for speech. Chunks play in order. */
  speak(text: string, cb?: { onStart?: () => void; onDone?: () => void }): void;
  /** Drop the queue and stop the current utterance. */
  cancel(): void;
}
