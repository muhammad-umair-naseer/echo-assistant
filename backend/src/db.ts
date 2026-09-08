/**
 * Persistence. Two tables:
 *   messages — the raw conversation log per session (context for the CURRENT
 *              session only; never replayed across sessions — that's the point).
 *   memories — durable facts extracted from conversation, each with a 384-dim
 *              embedding blob. This is the long-term memory: it survives
 *              sessions, and is queried by similarity, never dumped wholesale.
 */
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../data/echo.db");

export interface MemoryRow {
  id: number;
  fact: string;
  embedding: Buffer;
  source: string;
  created_at: string;
}

export interface MessageRow {
  id: number;
  session_id: string;
  role: string;
  content: string;
  created_at: string;
}

export function openDb(path = process.env.ECHO_DB ?? DEFAULT_PATH): Database.Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, id);

    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fact TEXT NOT NULL,
      embedding BLOB NOT NULL,
      source TEXT NOT NULL DEFAULT 'heuristic',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

export function addMessage(db: Database.Database, sessionId: string, role: string, content: string): void {
  db.prepare("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)").run(sessionId, role, content);
}

export function sessionMessages(db: Database.Database, sessionId: string, limit = 40): MessageRow[] {
  const rows = db
    .prepare("SELECT * FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?")
    .all(sessionId, limit) as MessageRow[];
  return rows.reverse();
}

export function insertMemory(db: Database.Database, fact: string, embedding: Float32Array, source: string): number {
  const res = db
    .prepare("INSERT INTO memories (fact, embedding, source) VALUES (?, ?, ?)")
    .run(fact, Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength), source);
  return Number(res.lastInsertRowid);
}

export function allMemories(db: Database.Database): MemoryRow[] {
  return db.prepare("SELECT * FROM memories ORDER BY id").all() as MemoryRow[];
}

export function deleteMemory(db: Database.Database, id: number): boolean {
  return db.prepare("DELETE FROM memories WHERE id = ?").run(id).changes > 0;
}

export function embeddingOf(row: MemoryRow): Float32Array {
  return new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
}
