import { db, uid, now, type JobRow } from "./db.js";
import { broadcast } from "./events.js";
import { runAgent, historyForProvider, getBot } from "./agent/loop.js";

/**
 * FIFO job queue per bot (nightly-labs openbot pattern): user sends, routines fire,
 * channels fan out — all become jobs. One job runs per bot at a time; paused bots
 * hold their jobs. Jobs are crash-safe rows in SQLite.
 */

export function enqueueJob(botId: string, conversationId: string, prompt: string, source: string, routineId?: string): JobRow {
  const id = uid();
  db.prepare("INSERT INTO queue_jobs (id, bot_id, conversation_id, prompt, source, status, created_at, routine_id) VALUES (?,?,?,?,?,?,?,?)").run(
    id, botId, conversationId, prompt.slice(0, 8000), source, "pending", now(), routineId ?? null
  );
  broadcast({ type: "queue.update", job: jobById(id) });
  void kickQueue();
  return jobById(id)!;
}

function jobById(id: string): JobRow | undefined {
  return db.prepare("SELECT * FROM queue_jobs WHERE id=?").get(id) as unknown as JobRow | undefined;
}

const inFlight = new Set<string>(); // bot ids currently running
/** 취소·와치독 신호를 실행 중 에이전트에 전달 (cooperative cancel): 루프 반복마다 검사 */
const stopSignals = new Set<string>();

/** 실행 중(포함 대기) 잡 취소 — 러닝 잡도 다음 루프 반복에서 즉시 중단된다 (기존: pending만 취소 → 토큰 낭비) */
export function requestStop(jobId: string): void {
  stopSignals.add(jobId);
}

export async function kickQueue(): Promise<void> {
  const pending = db.prepare("SELECT * FROM queue_jobs WHERE status='pending' ORDER BY created_at").all() as unknown as JobRow[];
  for (const job of pending) {
    if (inFlight.has(job.bot_id)) continue;
    const bot = getBot(job.bot_id);
    if (!bot || bot.status !== "active") continue;
    void runJob(job.id);
  }
}

const JOB_TIMEOUT_MS = Number(process.env.OPENBOT_JOB_TIMEOUT_MS ?? 30 * 60_000);

async function runJob(jobId: string): Promise<void> {
  await Promise.race([runJobInner(jobId), watchdog(jobId)]);
}

/** A job that exceeds the watchdog is marked error — no more silent hangs (QwenPaw #8571 spirit). */
function watchdog(jobId: string): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(() => {
      stopSignals.add(jobId); // watchdog도 에이전트를 멈춘다 — 기존: status만 바꾸고 에이전트는 계속 실행(이중 소모)
      const job = jobById(jobId);
      if (job && job.status === "running") {
        db.prepare("UPDATE queue_jobs SET status='error', result=?, finished_at=? WHERE id=? AND status='running'").run(`watchdog: ${JOB_TIMEOUT_MS / 60000}분 초과`, now(), jobId);
        broadcast({ type: "chat.error", jobId, conversationId: job.conversation_id, error: "watchdog: 작업 시간 초과" });
        broadcast({ type: "queue.update", job: jobById(jobId) });
      }
      resolve();
    }, JOB_TIMEOUT_MS).unref?.();
  });
}


/** Pick the best responder for an un-mentioned channel message (OpenMausBot Jev pattern, local model). */
async function pickAutoResponder(botIds: string[], prompt: string, channelInstructions: string): Promise<string[]> {
  if (botIds.length <= 1) return botIds;
  try {
    const { getBot, getProviderForBot, historyForProvider } = await import("./agent/loop.js");
    const { providerForRow, textContent } = await import("./agent/providers.js");
    const roster = botIds.map((id) => {
      const b = getBot(id);
      return b ? `${b.name}: ${b.persona.slice(0, 80)}` : "?";
    }).join("\n");
    const provider = providerForRow(undefined); // default provider (local model)
    const res = await provider.chat({
      messages: [
        { role: "system", content: `Pick the best bot to answer this message. Reply with ONLY the bot name, nothing else.\n\nBots:\n${roster}${channelInstructions ? `\nChannel context: ${channelInstructions.slice(0, 200)}` : ""}` },
        { role: "user", content: prompt.slice(0, 300) },
      ],
      tools: [],
    });
    const pick = textContent(res.message.content).trim().toLowerCase();
    const match = botIds.find((id) => {
      const b = getBot(id);
      return b && pick.includes(b.name.toLowerCase());
    });
    return match ? [match] : [botIds[0]];
  } catch {
    return [botIds[0]];
  }
}

async function runJobInner(jobId: string): Promise<void> {
  const job = jobById(jobId);
  if (!job || job.status !== "pending") return;
  db.prepare("UPDATE queue_jobs SET status='running' WHERE id=?").run(jobId);
  broadcast({ type: "queue.update", job: jobById(jobId) });
  inFlight.add(job.bot_id);
  try {
    const conv = db.prepare("SELECT * FROM conversations WHERE id=?").get(job.conversation_id) as unknown as { kind: string } | undefined;
    if (!conv) throw new Error("conversation missing");
    if (conv.kind === "channel") {
      const convRow = db.prepare("SELECT responder_mode, instructions FROM conversations WHERE id=?").get(job.conversation_id) as { responder_mode: string | null; instructions: string | null } | undefined;
      const mode = convRow?.responder_mode ?? "all";
      const channelInstructions = convRow?.instructions ?? "";
      const allMembers = db.prepare("SELECT bot_id, role FROM channel_members WHERE conversation_id=?").all(job.conversation_id) as { bot_id: string; role: string }[];
      // responder rules: 'all' = sequential (default), 'lead' = first active member only, 'auto' = model picks one
      let responders: string[];
      if (mode === "lead") {
        const lead = allMembers.find((m) => m.role === "lead") ?? allMembers[0];
        responders = lead ? [lead.bot_id] : [];
      } else if (mode === "auto") {
        const active = allMembers.filter((m) => getBot(m.bot_id)?.status === "active").map((m) => m.bot_id);
        responders = await pickAutoResponder(active, job.prompt, channelInstructions);
      } else {
        responders = allMembers.map((m) => m.bot_id);
      }
      for (const botId of responders) {
        const bot = getBot(botId);
        if (!bot || bot.status !== "active") continue;
        const res = await runAgent({
          botId,
          conversationId: job.conversation_id,
          history: historyForProvider(job.conversation_id),
          depth: 0,
          visited: [botId],
          jobId,
          initiator: job.source === "routine" ? "routine" : "person",
          isCancelled: () => stopSignals.has(jobId),
        });
        broadcast({ type: "chat.message", conversationId: job.conversation_id, botId, role: "assistant", content: res.text });
      }
    } else {
      const res = await runAgent({
        botId: job.bot_id,
        conversationId: job.conversation_id,
        history: historyForProvider(job.conversation_id),
        depth: 0,
        visited: [job.bot_id],
        jobId,
        initiator: job.source === "routine" ? "routine" : "person",
        isCancelled: () => stopSignals.has(jobId),
      });
      broadcast({ type: "chat.message", conversationId: job.conversation_id, botId: job.bot_id, role: "assistant", content: res.text });
    }
    if (stopSignals.has(jobId)) {
      db.prepare("UPDATE queue_jobs SET status='cancelled', result=?, finished_at=? WHERE id=? AND status='running'").run("user stopped", now(), jobId);
    } else {
      db.prepare("UPDATE queue_jobs SET status='done', result=?, finished_at=? WHERE id=?").run("", now(), jobId);
    }
    if (job.source === "routine" && job.routine_id) {
      // 실패 카운트는 '발화한 루틴'에 귀속 (기존: bot 단위 조회로 서로 다른 루틴끼리 카운트 오염)
      db.prepare("UPDATE routines SET failure_count=0 WHERE id=?").run(job.routine_id);
    }
    void import("./agent/loop.js").then((m) => m.maybeNameConversation(job.conversation_id));
  } catch (err) {
    const cancelled = stopSignals.has(jobId);
    const msg = cancelled ? "사용자가 중단했습니다" : err instanceof Error ? err.message : String(err);
    db.prepare("UPDATE queue_jobs SET status=?, result=?, finished_at=? WHERE id=? AND status='running'").run(cancelled ? "cancelled" : "error", msg, now(), jobId);
    if (!cancelled && job.source === "routine" && job.routine_id) {
      db.prepare("UPDATE routines SET failure_count=failure_count+1 WHERE id=?").run(job.routine_id);
      const f = db.prepare("SELECT failure_count, enabled FROM routines WHERE id=?").get(job.routine_id) as { failure_count: number; enabled: number } | undefined;
      if (f && f.failure_count >= 10 && f.enabled) db.prepare("UPDATE routines SET enabled=0 WHERE id=?").run(job.routine_id);
    }
    broadcast({ type: "chat.error", jobId, conversationId: job.conversation_id, error: msg });
  } finally {
    inFlight.delete(job.bot_id);
    stopSignals.delete(jobId);
    broadcast({ type: "queue.update", job: jobById(jobId) });
    void kickQueue();
  }
}

export function cancelJob(jobId: string): boolean {
  stopSignals.add(jobId); // 러닝 잡이면 에이전트가 다음 루프 반복에서 즉시 중단
  const res = db.prepare("UPDATE queue_jobs SET status='cancelled', finished_at=? WHERE id=? AND status='pending'").run(now(), jobId);
  broadcast({ type: "queue.update", job: jobById(jobId) });
  return res.changes > 0;
}

/** Cancel every pending/running job in a conversation (steering "stop"). */
export function cancelByConversation(conversationId: string): number {
  const rows = db.prepare("SELECT id FROM queue_jobs WHERE conversation_id=? AND status IN ('pending','running')").all(conversationId) as { id: string }[];
  for (const r of rows) cancelJob(r.id);
  return rows.length;
}

export function listJobs(limit = 50): JobRow[] {
  return db.prepare("SELECT * FROM queue_jobs ORDER BY created_at DESC LIMIT ?").all(limit) as unknown as JobRow[];
}
