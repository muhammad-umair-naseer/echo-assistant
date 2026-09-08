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
const MIN_CHARS = 24;

export class SentenceStreamer {
  private buf = "";
  private pending = "";
  private readonly emit: (sentence: string) => void;

  constructor(emit: (sentence: string) => void) {
    this.emit = emit;
  }

  push(token: string): void {
    this.buf += token;
    for (;;) {
      const m = BOUNDARY.exec(this.buf);
      if (!m) return;
      const end = m.index + m[1]!.length;
      const candidate = `${this.pending}${this.buf.slice(0, end)}`.trim();
      this.buf = this.buf.slice(end).replace(/^\s+/, "");
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
    const rest = `${this.pending}${this.buf}`.trim();
    this.pending = "";
    this.buf = "";
    if (rest) this.emit(rest);
  }
}
