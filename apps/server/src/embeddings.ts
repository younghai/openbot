import { db, uid } from "./db.js";

/**
 * 임베딩 기반 의미 검색 (하이브리드 RAG). Ollama bge-m3(다국어, 1024차원)로
 * 청크를 임베딩해 FTS5 어휘 매칭이 놓치는 한국어 유의어·문장 검색을 보강한다.
 *
 * 무키 철학 유지: Ollama에 임베딩 모델이 없으면 조용히 FTS-only로 폴백한다.
 * 검색은 RRF(reciprocal rank fusion)로 병합 — 점수 정규화가 필요 없어 두 검색기를
 * 같은 가중치로 섞는 표준 기법.
 */

const EMBED_MODEL = process.env.OPENBOT_EMBED_MODEL || "bge-m3";
const OLLAMA_BASE = process.env.OPENBOT_OLLAMA_BASE || "http://localhost:11434";
const EMBED_TIMEOUT_MS = 30_000;
const BATCH = 32;

db.exec(`CREATE TABLE IF NOT EXISTS knowledge_vec (
  chunk_id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  source TEXT NOT NULL,
  content TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  model TEXT NOT NULL,
  vec BLOB NOT NULL
)`);
db.exec("CREATE INDEX IF NOT EXISTS kv_bot ON knowledge_vec (bot_id)");

let availableCache: boolean | null = null;
let availableCheckedAt = 0;

/** Ollama에 임베딩 모델이 있는지 (60초 캐시 — 모델 pull 후 재탐색된다) */
export async function embeddingsAvailable(): Promise<boolean> {
  if (availableCache !== null && Date.now() - availableCheckedAt < 60_000) return availableCache;
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/tags`, { signal: AbortSignal.timeout(3000) });
    const body = (await res.json()) as { models?: { name: string }[] };
    availableCache = (body.models ?? []).some((m) => m.name.startsWith(EMBED_MODEL));
  } catch {
    availableCache = false;
  }
  availableCheckedAt = Date.now();
  return availableCache;
}

async function embedBatch(inputs: string[]): Promise<number[][]> {
  const res = await fetch(`${OLLAMA_BASE}/api/embed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, input: inputs }),
    signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`ollama embed ${res.status}`);
  const body = (await res.json()) as { embeddings?: number[][] };
  if (!body.embeddings?.length) throw new Error("ollama embed: empty");
  return body.embeddings;
}

/** 단위 벡터로 정규화해 저장 — 검색 시 내적 = 코사인 유사도 */
function normalize(vec: number[]): Float32Array {
  const out = new Float32Array(vec.length);
  let norm = 0;
  for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / norm;
  return out;
}

/**
 * 문서 청크를 임베딩해 저장 (색인). FTS 행들과 별도 테이블 — 기존 색인과 독립적.
 * 모델이 없으면 0을 반환하고 조용히 건너뛴다.
 */
export async function embedDocument(botId: string, source: string, chunks: string[]): Promise<number> {
  db.prepare("DELETE FROM knowledge_vec WHERE bot_id=? AND source=?").run(botId, source);
  if (chunks.length === 0) return 0;
  if (!(await embeddingsAvailable())) return 0;
  const ins = db.prepare("INSERT OR REPLACE INTO knowledge_vec (chunk_id, bot_id, source, content, chunk_index, model, vec) VALUES (?,?,?,?,?,?,?)");
  let done = 0;
  try {
    for (let start = 0; start < chunks.length; start += BATCH) {
      const part = chunks.slice(start, start + BATCH);
      const vectors = await embedBatch(part);
      part.forEach((content, i) => {
        ins.run(uid(), botId, source, content, start + i, EMBED_MODEL, Buffer.from(normalize(vectors[i] ?? []).buffer));
      });
      done += part.length;
    }
  } catch {
    // 부분 색인도 유의미 — 이미 삽입된 것까지 사용된다
  }
  return done;
}

/** 쿼리 임베딩 → 벡터 유사도 상위 (정규화 벡터라 내적=코사인) */
export async function searchByVector(botId: string, query: string, limit = 10): Promise<{ chunk_id: string; source: string; content: string; chunk_index: number }[]> {
  if (!(await embeddingsAvailable())) return [];
  let qvec: Float32Array;
  try {
    qvec = normalize((await embedBatch([query]))[0] ?? []);
  } catch {
    return [];
  }
  const rows = db.prepare("SELECT chunk_id, source, content, chunk_index, vec FROM knowledge_vec WHERE bot_id=?").all(botId) as { chunk_id: string; source: string; content: string; chunk_index: number; vec: Buffer }[];
  const scored = rows
    .map((r) => {
      const v = new Float32Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength / 4);
      let dot = 0;
      for (let i = 0; i < qvec.length; i++) dot += qvec[i] * v[i];
      return { chunk_id: r.chunk_id, source: r.source, content: r.content, chunk_index: r.chunk_index, score: dot };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return scored;
}

/** 문서 제거 시 벡터도 정리 */
export function removeEmbeddings(botId: string, source: string): void {
  db.prepare("DELETE FROM knowledge_vec WHERE bot_id=? AND source=?").run(botId, source);
}

/** RRF 병합: 두 랭킹을 같은 가중치로 융합 (k=60 표준). FTS 행을 우선, 벡터만 낀 항목은 그대로 승격. */
export function fuseRanks<T extends { source: string; content: string; chunk_index: number }>(
  fts: T[],
  vec: { source: string; content: string; chunk_index: number }[],
  limit: number
): T[] {
  const entries = new Map<string, { item: T; s: number }>();
  const bump = (item: { source: string; content: string; chunk_index: number }, rank: number): void => {
    const key = `${item.source}#${item.chunk_index}`;
    let e = entries.get(key);
    if (!e) {
      e = { item: (fts.find((f) => f.source === item.source && f.chunk_index === item.chunk_index) ?? item) as T, s: 0 };
      entries.set(key, e);
    }
    e.s += 1 / (60 + rank + 1);
  };
  fts.forEach((item, rank) => bump(item, rank));
  vec.forEach((item, rank) => bump(item, rank));
  return [...entries.values()].sort((a, b) => b.s - a.s).slice(0, limit).map((e) => e.item);
}
