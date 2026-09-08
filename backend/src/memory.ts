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
import { allMemories, embeddingOf, insertMemory } from "./db.ts";
import { cosine, embed } from "./embeddings.ts";

export const TOP_K = 5;
export const MIN_SCORE = 0.25; // below this, a memory is judged irrelevant to the query
export const DUP_THRESHOLD = 0.92; // above this, a new fact is a duplicate of an existing one

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

/** Store facts, skipping near-duplicates of existing memories. Returns stored rows. */
export async function remember(
  db: Database.Database,
  facts: string[],
  source: string,
): Promise<{ id: number; fact: string }[]> {
  if (facts.length === 0) return [];
  const existing = allMemories(db).map((r) => ({ row: r, vec: embeddingOf(r) }));
  const stored: { id: number; fact: string }[] = [];
  for (const fact of facts) {
    const vec = await embed(fact);
    // Dedup against DB rows AND facts stored earlier in this same call
    // (`existing` grows as we insert).
    if (existing.some((e) => cosine(vec, e.vec) >= DUP_THRESHOLD)) continue;
    const id = insertMemory(db, fact, vec, source);
    existing.push({ row: { id, fact, embedding: Buffer.from(vec.buffer.slice(0)), source, created_at: "" }, vec });
    stored.push({ id, fact });
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
