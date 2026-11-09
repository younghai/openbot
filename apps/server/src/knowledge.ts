
/**
 * Knowledge base (LobeHub/Open WebUI RAG pattern): documents uploaded to
 * data/knowledge/<bot>/ are chunked and indexed with SQLite FTS5. Relevant
 * chunks are injected into the system prompt at conversation time.
 */
import fs from "node:fs";
import path from "node:path";
import { db, uid, now } from "./db.js";
import { DATA_DIR } from "./config.js";

export const KNOWLEDGE_DIR = path.join(DATA_DIR, "knowledge");
const CHUNK_SIZE = 800;
const CHUNK_OVERLAP = 100;

// FTS5 virtual table for full-text search
db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
  chunk_id UNINDEXED, bot_id UNINDEXED, source UNINDEXED, content, chunk_index UNINDEXED
)`);

function botDir(botId: string): string {
  return path.join(KNOWLEDGE_DIR, botId);
}

/** Chunk a document into overlapping pieces for FTS indexing. */
export function chunkDocument(text: string): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + CHUNK_SIZE, text.length);
    chunks.push(text.slice(start, end).trim());
    start = end - CHUNK_OVERLAP;
    if (start < 0) start = 0;
    if (start >= text.length) break;
    if (chunks.length > 500) break;
  }
  return chunks.filter((c) => c.length > 10);
}

/** Index a document for a bot. Returns chunk count. */
export function indexDocument(botId: string, source: string, text: string): number {
  const clean = text.replace(/\r\n/g, "\n").replace(/\s+/g, " ").trim();
  if (!clean) return 0;
  // remove old chunks for this source
  db.prepare("DELETE FROM knowledge_fts WHERE bot_id=? AND source=?").run(botId, source);
  const chunks = chunkDocument(clean);
  const ins = db.prepare("INSERT INTO knowledge_fts (chunk_id, bot_id, source, content, chunk_index) VALUES (?,?,?,?,?)");
  chunks.forEach((content, i) => ins.run(uid(), botId, source, content, i));
  return chunks.length;
}

/** Read a file from disk and index it. */
export function indexFile(botId: string, filePath: string): number {
  try {
    const abs = path.resolve(botDir(botId), filePath);
    if (!abs.startsWith(path.resolve(botDir(botId)))) return 0;
    if (!fs.existsSync(abs)) return 0;
    const text = fs.readFileSync(abs, "utf8");
    return indexDocument(botId, path.basename(filePath), text);
  } catch { return 0; }
}

/** Search knowledge chunks for a bot, ranked by FTS relevance. */
export function searchKnowledge(botId: string, query: string, limit = 5): { source: string; content: string; chunk_index: number }[] {
  try {
    const sanitized = query.replace(/["'*()]/g, " ").trim();
    if (!sanitized || sanitized.length < 2) return [];
    const rows = db.prepare(
      `SELECT source, content, chunk_index FROM knowledge_fts
       WHERE knowledge_fts MATCH ? AND bot_id=? LIMIT ?`
    ).all(sanitized, botId, limit) as { source: string; content: string; chunk_index: number }[];
    return rows;
  } catch {
    return [];
  }
}

/** Build a knowledge context block for the system prompt. */
export function knowledgeContext(botId: string, focusText?: string): string | null {
  const query = focusText ?? "";
  const results = searchKnowledge(botId, query, 5);
  if (results.length === 0) return null;
  const lines = ["Relevant knowledge from uploaded documents:"];
  for (const r of results) {
    lines.push(`[${r.source} #${r.chunk_index}] ${r.content.slice(0, 300)}`);
  }
  return lines.join("\n");
}

/** List indexed documents for a bot. */
export function listKnowledge(botId: string): { source: string; chunks: number }[] {
  const rows = db.prepare(
    "SELECT source, COUNT(*) as n FROM knowledge_fts WHERE bot_id=? GROUP BY source"
  ).all(botId) as { source: string; n: number }[];
  return rows.map((r) => ({ source: r.source, chunks: r.n }));
}

/** Remove all knowledge for a source. */
export function removeKnowledge(botId: string, source: string): void {
  db.prepare("DELETE FROM knowledge_fts WHERE bot_id=? AND source=?").run(botId, source);
}
