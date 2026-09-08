/**
 * The memory brain — retrieval-augmented long-term memory.
 *
 * Write path:  after each exchange, extract durable facts from what the USER
 *              said (LLM-based when a Groq key exists, regex heuristics
 *              otherwise), embed each fact, and store it — deduplicated by
 *              cosine similarity so "my name is Ada" twice is one memory.
 * Read path:   embed the incoming message, score EVERY stored memory by cosine,
 *              inject only the top-k above a floor into the system prompt.
 *
 * Context therefore stays O(k) no matter how many sessions of history exist —
 * that's the answer to "why not just a big context window": windows are finite,
 * cost grows linearly with history, and attention degrades as they fill. This
 * retrieves 5 relevant facts whether the user has 10 memories or 10,000.
 *
 * Retrieval is exact brute-force cosine over all rows. At personal scale
 * (hundreds..thousands of facts) that's simpler and exact; an ANN index
 * (sqlite-vec / HNSW) is the drop-in swap at ~10k+ vectors.
 */
import type Database from "better-sqlite3";
import { allMemories, deleteMemory, embeddingOf, insertMemory } from "./db.ts";
import { cosine, embed } from "./embeddings.ts";

export const TOP_K = 5;
export const MIN_SCORE = 0.25; // below this, a memory is judged irrelevant to the query
export const DUP_THRESHOLD = 0.92; // above this, a new fact is a duplicate of an existing one
export const RELATED_THRESHOLD = 0.35; // candidates for contradiction judging (same subject-ish)

export type MemoryCategory = "identity" | "preference" | "project" | "relationship" | "context" | "misc";

/** Cheap keyless categorizer; the LLM extractor supplies categories when keyed. */
export function categorize(fact: string): MemoryCategory {
  const f = fact.toLowerCase();
  if (/\b(name is|call(ed)? me|alias|born|birthday|i am from|i'm from|live[sd]? in|my age)\b/.test(f)) return "identity";
  if (/\b(prefer|favorite|favourite|like[sd]?|love[sd]?|hate[sd]?|dislike|enjoy)\b/.test(f)) return "preference";
  if (/\b(build(ing)?|working on|project|startup|app|repo|launch|ship)\b/.test(f)) return "project";
  if (/\b(wife|husband|partner|sister|brother|mother|father|mom|dad|son|daughter|friend|dog|cat|pet)\b/.test(f))
    return "relationship";
  if (/\b(work|job|company|team|school|university|exam|deadline|moving|trip)\b/.test(f)) return "context";
  return "misc";
}

export interface RecalledMemory {
  id: number;
  fact: string;
  score: number;
}

/** Durable-fact patterns for keyless operation. Deliberately conservative:
 *  each match is a statement about the user likely to matter days later. */
const FACT_PATTERNS: RegExp[] = [
  /\bmy name is\b[^.!?\n]*/i,
  /\bcall me\b[^.!?\n]*/i,
  /\bi(?:'| a)m called\b[^.!?\n]*/i,
  /\bi(?:'| a)m building\b[^.!?\n]*/i,
  /\bi(?:'| a)m working on\b[^.!?\n]*/i,
  /\bi work\b[^.!?\n]*/i,
  /\bi live\b[^.!?\n]*/i,
  /\bi(?:'| a)m from\b[^.!?\n]*/i,
  /\bi prefer\b[^.!?\n]*/i,
  /\bi (?:love|like|hate|dislike)\b[^.!?\n]*/i,
  /\bmy (?:favorite|favourite)\b[^.!?\n]*/i,
  /\bi use\b[^.!?\n]*/i,
  /\bmy (?:job|role|company|team|project|stack|birthday|dog|cat|wife|husband|partner|son|daughter)\b[^.!?\n]*/i,
  /\bi(?:'| ha)ve (?:a|an|two|three)\b[^.!?\n]*/i,
];

/** Extract durable facts from a user message with regex heuristics (no key). */
export function extractFactsHeuristic(userMessage: string): string[] {
  const facts = new Set<string>();
  for (const pattern of FACT_PATTERNS) {
    const m = userMessage.match(pattern);
    if (m) {
      const fact = m[0].trim().replace(/\s+/g, " ");
      if (fact.length >= 8 && fact.length <= 200) facts.add(fact);
    }
  }
  return [...facts];
}

export interface StoredFact {
  id: number;
  fact: string;
  category: string;
  replaced?: string; // the old fact this one superseded (contradiction resolution)
}

/** Decides which existing memories a new fact SUPERSEDES. Injected by the
 *  server (an LLM judge when a key exists); memory.ts itself stays model-free.
 *  Measured reality: contradictions are NOT detectable by embedding similarity —
 *  cosine("I live in Lisbon", "I live in Berlin") is only ~0.48, the same range
 *  as merely-related facts — so similarity picks CANDIDATES and the judge
 *  decides. Without a judge (keyless), contradictions accumulate (documented). */
export type SupersedeJudge = (newFact: string, candidates: { id: number; fact: string }[]) => Promise<number[]>;

/**
 * Store facts: exact-ish duplicates (cosine >= 0.92) are skipped; related
 * existing memories (cosine >= 0.35, top 3) are offered to the supersede judge,
 * and any it rules contradicted are deleted and reported as `replaced`.
 */
export async function remember(
  db: Database.Database,
  facts: (string | { fact: string; category?: string })[],
  source: string,
  judge?: SupersedeJudge,
): Promise<StoredFact[]> {
  if (facts.length === 0) return [];
  const existing = allMemories(db).map((r) => ({ row: r, vec: embeddingOf(r) }));
  const stored: StoredFact[] = [];
  for (const raw of facts) {
    const fact = typeof raw === "string" ? raw : raw.fact;
    const category = (typeof raw === "string" ? undefined : raw.category) ?? categorize(fact);
    const vec = await embed(fact);
    // Dedup against DB rows AND facts stored earlier in this same call
    // (`existing` grows as we insert).
    const scored = existing
      .map((e, i) => ({ i, c: cosine(vec, e.vec) }))
      .sort((a, b) => b.c - a.c);
    if ((scored[0]?.c ?? 0) >= DUP_THRESHOLD) continue;

    let replaced: string | undefined;
    if (judge) {
      const candidates = scored
        .filter((s2) => s2.c >= RELATED_THRESHOLD)
        .slice(0, 3)
        .map((s2) => ({ id: existing[s2.i]!.row.id, fact: existing[s2.i]!.row.fact }));
      if (candidates.length > 0) {
        const retire = await judge(fact, candidates).catch(() => [] as number[]);
        const retired = candidates.filter((c) => retire.includes(c.id));
        if (retired.length > 0) {
          replaced = retired.map((r) => r.fact).join(" · ");
          for (const r of retired) {
            deleteMemory(db, r.id);
            const idx = existing.findIndex((e) => e.row.id === r.id);
            if (idx >= 0) existing.splice(idx, 1);
          }
        }
      }
    }

    const id = insertMemory(db, fact, vec, source, category);
    existing.push({
      row: { id, fact, embedding: Buffer.from(vec.buffer.slice(0)), source, category, created_at: "" },
      vec,
    });
    stored.push({ id, fact, category, ...(replaced ? { replaced } : {}) });
  }
  return stored;
}

/** "Tell me what you know about me" — a profile dump, not a topical lookup.
 *  Similarity retrieval is the wrong tool for it: the question is semantically
 *  distant from every SPECIFIC fact, so scores fall below the floor and the
 *  assistant would honestly claim it knows nothing while the bank is full. */
const META_QUERY =
  /\bwhat (?:do|can|did) you (?:remember|know)\b|\bremember (?:anything )?about me\b|\bknow about me\b|\bwho am i\b|\bmy profile\b|\beverything you (?:know|remember)\b/i;
const META_CAP = 12;

/** Retrieve the top-k memories relevant to a query. Scores every row (exact).
 *  Meta-queries about the user return the whole profile (capped) instead. */
export async function recall(db: Database.Database, query: string, k = TOP_K): Promise<RecalledMemory[]> {
  const rows = allMemories(db);
  if (rows.length === 0) return [];
  const qvec = await embed(query);
  const scored = rows
    .map((r) => ({ id: r.id, fact: r.fact, score: cosine(qvec, embeddingOf(r)) }))
    .sort((a, b) => b.score - a.score);
  if (META_QUERY.test(query)) return scored.slice(0, META_CAP);
  return scored.filter((m) => m.score >= MIN_SCORE).slice(0, k);
}

export const BASE_SYSTEM_PROMPT =
  "You are JARVIS, a personal AI assistant with a calm, capable, lightly wry " +
  "manner. Reply concisely, in plain text (no markdown headers). You have a " +
  "long-term memory: facts about the user retrieved from prior sessions may be " +
  "listed below — treat them as things you genuinely remember, and use them " +
  "naturally when relevant.";

/**
 * Build the system prompt for a message. `withRetrieval:false` exists for the
 * proof's control arm: identical prompt construction, minus the memory lookup.
 */
export async function buildSystemPrompt(
  db: Database.Database,
  userMessage: string,
  withRetrieval: boolean,
): Promise<{ prompt: string; recalled: RecalledMemory[] }> {
  const recalled = withRetrieval ? await recall(db, userMessage) : [];
  if (recalled.length === 0) return { prompt: BASE_SYSTEM_PROMPT, recalled };
  const lines = recalled.map((m) => `- ${m.fact}`).join("\n");
  return {
    prompt: `${BASE_SYSTEM_PROMPT}\n\nLong-term memory (facts about the user from prior sessions):\n${lines}`,
    recalled,
  };
}
