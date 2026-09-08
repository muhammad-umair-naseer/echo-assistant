/**
 * Sentence-streaming chunker — the piece that keeps voice latency honest.
 *
 * LLM tokens arrive one by one; waiting for the full reply before speaking
 * adds seconds of dead air. This accumulates tokens and emits a chunk as soon
 * as a sentence boundary lands, so TTS starts on sentence one while the model
 * is still writing sentence three. flush() emits whatever remains at stream end.
 *
 * Sentences shorter than MIN_CHARS aren't shipped alone ("Ok." as its own
 * utterance sounds clipped) — they're held and merged into the next chunk.
 */

// A boundary is punctuation FOLLOWED BY WHITESPACE — never end-of-buffer, since
// a token chunk can end mid-number ("The value is 3.") with more still coming.
// End-of-stream is flush()'s job.
const BOUNDARY = /([.!?…]+["')\]]?)\s+/;
// Periods that end an abbreviation, not a sentence ("e.g. caching").
const ABBREV = /\b(?:e\.g|i\.e|etc|vs|cf|approx|dr|mr|mrs|ms|prof|st|no|fig)\.["')\]]?$/i;
const MIN_CHARS = 24;

export class SentenceStreamer {
  private buf = "";
  private pending = "";
  private stopped = false;
  private readonly emit: (sentence: string) => void;

  constructor(emit: (sentence: string) => void) {
    this.emit = emit;
  }

  /** Mute permanently — Esc / voice-off / a new message mid-stream. Tokens may
   *  keep arriving; nothing further is emitted. */
  stop(): void {
    this.stopped = true;
    this.buf = "";
    this.pending = "";
  }

  push(token: string): void {
    if (this.stopped) return;
    this.buf += token;
    let from = 0;
    for (;;) {
      const m = BOUNDARY.exec(this.buf.slice(from));
      if (!m) return;
      const end = from + m.index + m[1]!.length;
      const before = this.buf.slice(0, end);
      if (ABBREV.test(before)) {
        from = end + 1; // "e.g. " — not a sentence end; keep scanning past it
        continue;
      }
      const candidate = `${this.pending}${before}`.trim();
      this.buf = this.buf.slice(end).replace(/^\s+/, "");
      from = 0;
      if (candidate.length < MIN_CHARS) {
        this.pending = `${candidate} `; // too short to speak alone — merge forward
        continue;
      }
      this.pending = "";
      this.emit(candidate);
    }
  }

  /** Stream over — emit any remainder (held fragment + partial sentence). */
  flush(): void {
    if (this.stopped) return;
    const rest = `${this.pending}${this.buf}`.trim();
    this.pending = "";
    this.buf = "";
    if (rest) this.emit(rest);
  }
}
