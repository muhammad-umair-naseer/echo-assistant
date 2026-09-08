import { describe, expect, it } from "vitest";
import { SentenceStreamer } from "./sentences.ts";

const collect = () => {
  const out: string[] = [];
  const s = new SentenceStreamer((x) => out.push(x));
  return { s, out };
};

describe("SentenceStreamer — speak while the model is still writing", () => {
  it("emits a sentence the moment its boundary arrives, before the stream ends", () => {
    const { s, out } = collect();
    for (const t of ["Your name ", "is Ozymandias ", "Vane. ", "You are ", "building"]) s.push(t);
    // First sentence went out mid-stream — TTS can start now.
    expect(out).toEqual(["Your name is Ozymandias Vane."]);
    s.push(" a drone.");
    expect(out).toEqual(["Your name is Ozymandias Vane."]); // no trailing space yet — stream may continue
    s.flush(); // stream over
    expect(out).toEqual(["Your name is Ozymandias Vane.", "You are building a drone."]);
  });

  it("handles several sentences landing in one token chunk", () => {
    const { s, out } = collect();
    s.push("The first full sentence lands here. The second one also lands here. And a trailing bit");
    expect(out).toEqual(["The first full sentence lands here.", "The second one also lands here."]);
    s.flush();
    expect(out[2]).toBe("And a trailing bit");
  });

  it("merges too-short sentences forward instead of speaking 'Ok.' alone", () => {
    const { s, out } = collect();
    s.push("Ok. ");
    expect(out).toEqual([]); // held
    s.push("Your submarine drone project is saved to memory. ");
    expect(out).toEqual(["Ok. Your submarine drone project is saved to memory."]);
  });

  it("flush emits held fragments even when no boundary ever arrived", () => {
    const { s, out } = collect();
    s.push("Ok. ");
    s.push("sure");
    s.flush();
    expect(out).toEqual(["Ok. sure"]);
    s.flush();
    expect(out).toHaveLength(1); // flush is idempotent when empty
  });

  it("respects ?, !, … and closing quotes as boundaries", () => {
    const { s, out } = collect();
    s.push('He asked "what is my name?" Then the terminal replied loudly!');
    s.flush();
    expect(out[0]).toBe('He asked "what is my name?"');
    expect(out[1]).toBe("Then the terminal replied loudly!");
  });

  it("never emits decimal numbers split at the period", () => {
    const { s, out } = collect();
    s.push("The value is 3.14 which is pi and that is the whole story here.");
    s.flush();
    expect(out).toEqual(["The value is 3.14 which is pi and that is the whole story here."]);
  });

  it("does not split at abbreviations like 'e.g.' mid-sentence", () => {
    const { s, out } = collect();
    s.push("There are many options, e.g. caching or memoization. Also see Dr. Smith for more.");
    s.flush();
    expect(out).toEqual([
      "There are many options, e.g. caching or memoization.",
      "Also see Dr. Smith for more.",
    ]);
  });

  it("stop() mutes everything after it — Esc mid-reply must stay silent", () => {
    const { s, out } = collect();
    s.push("The first full sentence lands here. And then ");
    expect(out).toHaveLength(1);
    s.stop(); // Esc pressed
    s.push("more tokens keep arriving. And another sentence. ");
    s.flush();
    expect(out).toHaveLength(1); // nothing after stop
  });

  it("does not fire early when a token chunk happens to end at '3.'", () => {
    const { s, out } = collect();
    s.push("The value is 3."); // stream paused mid-number — NOT a sentence end
    expect(out).toEqual([]);
    s.push("14 rounded, obviously, to two decimal places. Next sentence starts");
    expect(out).toEqual(["The value is 3.14 rounded, obviously, to two decimal places."]);
  });
});
