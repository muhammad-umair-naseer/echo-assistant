import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addMessage, openDb, sessionMessages } from "./db.ts";
import { buildSystemPrompt, extractFactsHeuristic, recall, remember } from "./memory.ts";
import { completeOnce, hasKey } from "./llm.ts";

const tmpDb = () => join(tmpdir(), `echo-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);

describe("retrieval-augmented memory — the proof", () => {
  it("recalls a fact in a NEW session via retrieval; the no-retrieval control does not", async () => {
    const path = tmpDb();

    // ---- SESSION 1: the user states a fact -------------------------------
    let db = openDb(path);
    const msg = "Hey! My name is Ozymandias Vane, and I'm building a submarine drone.";
    addMessage(db, "session-1", "user", msg);
    const facts = extractFactsHeuristic(msg);
    expect(facts.join(" ")).toContain("Ozymandias"); // extraction caught the name
    await remember(db, facts, "heuristic");
    db.close(); // session over — process gone, context window gone

    // ---- SESSION 2: fresh connection, new session id, EMPTY history ------
    db = openDb(path);
    expect(sessionMessages(db, "session-2")).toHaveLength(0); // nothing carried over in context

    const question = "what is my name?";
    // WITH retrieval: the fact comes back from the vector store...
    const withRetrieval = await buildSystemPrompt(db, question, true);
    expect(withRetrieval.prompt).toContain("Ozymandias");
    expect(withRetrieval.recalled.length).toBeGreaterThan(0);

    // CONTROL, retrieval disabled: identical prompt construction, no memory —
    // the fact is nowhere in context. THIS is the difference between real
    // long-term memory and a long context window.
    const control = await buildSystemPrompt(db, question, false);
    expect(control.prompt).not.toContain("Ozymandias");
    db.close();
  }, 120_000);

  it("retrieves the RELEVANT memory for the query, not everything", async () => {
    const db = openDb(tmpDb());
    await remember(
      db,
      [
        "my name is Ozymandias Vane",
        "I'm building a submarine drone",
        "I prefer tabs over spaces",
        "my dog is called Biscuit",
      ],
      "heuristic",
    );
    const top = await recall(db, "what project am I working on?", 1);
    expect(top[0]!.fact).toContain("submarine drone");
    const topName = await recall(db, "who am I? what's my name?", 1);
    expect(topName[0]!.fact).toContain("Ozymandias");
    db.close();
  }, 120_000);

  it("answers meta-queries ('what do you remember about me?') with the whole profile", async () => {
    const db = openDb(tmpDb());
    await remember(
      db,
      ["my name is Ozymandias Vane", "I'm building a submarine drone", "my dog is called Biscuit"],
      "heuristic",
    );
    // Topically distant from every specific fact — similarity alone returns
    // little or nothing; the meta-query path must return everything instead.
    const all = await recall(db, "what do you remember about me?");
    expect(all.length).toBe(3);
    const who = await recall(db, "who am I?");
    expect(who.length).toBe(3);
    db.close();
  }, 120_000);

  it("dedups near-identical facts instead of storing them twice", async () => {
    const db = openDb(tmpDb());
    const first = await remember(db, ["my name is Ozymandias Vane"], "heuristic");
    expect(first).toHaveLength(1);
    const second = await remember(db, ["My name is Ozymandias Vane."], "heuristic");
    expect(second).toHaveLength(0); // recognized as the same memory
    db.close();
  }, 120_000);
});

describe("live LLM recall (auto-skipped without GROQ_API_KEY)", () => {
  it.skipIf(!hasKey())("the model answers with the remembered name in a fresh session", async () => {
    const db = openDb(tmpDb());
    await remember(db, ["user's name is Ozymandias Vane"], "test");

    const question = "What is my name? Answer with just the name.";
    const { prompt } = await buildSystemPrompt(db, question, true);
    const withMemory = await completeOnce(
      [
        { role: "system", content: prompt },
        { role: "user", content: question },
      ],
      500,
    );
    expect(withMemory).toContain("Ozymandias");

    const { prompt: bare } = await buildSystemPrompt(db, question, false);
    const withoutMemory = await completeOnce(
      [
        { role: "system", content: bare },
        { role: "user", content: question },
      ],
      500,
    );
    expect(withoutMemory).not.toContain("Ozymandias");
    db.close();
  }, 120_000);
});

describe("tools", () => {
  it("get_time returns a local timestamp; open_url validates protocols", async () => {
    const { execTool, validUrl } = await import("./tools.ts");
    const t = await execTool({ id: "1", type: "function", function: { name: "get_time", arguments: "{}" } });
    expect(t.result).toMatch(/\d{1,2}[:.]\d{2}/);
    expect(validUrl("https://example.com")).toBe("https://example.com/");
    expect(validUrl("javascript:alert(1)")).toBeNull();
    const bad = await execTool({ id: "2", type: "function", function: { name: "open_url", arguments: '{"url":"ftp://x"}' } });
    expect(bad.clientAction).toBeUndefined();
  });
});

describe("memory upgrades", () => {
  it.skipIf(!hasKey())("LLM judge retires a contradicted fact — one truth remains", async () => {
    const db = openDb(tmpDb());
    const { judgeSupersede } = await import("./llm.ts");
    await remember(db, ["I live in Lisbon"], "test", judgeSupersede);
    const second = await remember(db, ["I live in Berlin now"], "test", judgeSupersede);
    expect(second).toHaveLength(1);
    expect(second[0]!.replaced).toContain("Lisbon"); // old truth retired by the judge
    const all = await recall(db, "where do I live?", 5);
    const texts = all.map((m) => m.fact).join(" | ");
    expect(texts).toContain("Berlin");
    expect(texts).not.toContain("Lisbon");
    db.close();
  }, 120_000);

  it.skipIf(!hasKey())("LLM judge does NOT retire merely-related facts", async () => {
    const db = openDb(tmpDb());
    const { judgeSupersede } = await import("./llm.ts");
    await remember(db, ["my dog is called Biscuit"], "test", judgeSupersede);
    const second = await remember(db, ["my dog just turned three years old"], "test", judgeSupersede);
    expect(second).toHaveLength(1);
    expect(second[0]!.replaced).toBeUndefined(); // age fact doesn't replace the name fact
    const { allMemories } = await import("./db.ts");
    expect(allMemories(db)).toHaveLength(2);
    db.close();
  }, 120_000);

  it("keeps genuinely different facts side by side (no false supersede)", async () => {
    const db = openDb(tmpDb());
    await remember(db, ["my dog is called Biscuit"], "test");
    const second = await remember(db, ["I'm building a submarine drone"], "test");
    expect(second[0]!.replaced).toBeUndefined();
    const { allMemories } = await import("./db.ts");
    expect(allMemories(db)).toHaveLength(2);
    db.close();
  }, 120_000);

  it("categorizes facts heuristically", async () => {
    const { categorize } = await import("./memory.ts");
    expect(categorize("my name is Ada")).toBe("identity");
    expect(categorize("I prefer tabs over spaces")).toBe("preference");
    expect(categorize("I'm building a submarine drone")).toBe("project");
    expect(categorize("my dog is called Biscuit")).toBe("relationship");
  });
});
