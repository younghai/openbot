import { db, uid, now, type JobRow } from "./db.js";
import { broadcast } from "./events.js";
import { runAgent, historyForProvider, getBot } from "./agent/loop.js";

/**
 * FIFO job queue per bot (nightly-labs openbot pattern): user sends, routines fire,
 * channels fan out — all become jobs. One job runs per bot at a time; paused bots
 * hold their jobs. Jobs are crash-safe rows in SQLite.
 */

export function enqueueJob(botId: string, conversationId: string, prompt: string, source: string): JobRow {
  const id = uid();
  db.prepare("INSERT INTO queue_jobs (id, bot_id, conversation_id, prompt, source, status, created_at) VALUES (?,?,?,?,?,?,?)").run(
    id, botId, conversationId, prompt.slice(0, 8000), source, "pending", now()
  );
  broadcast({ type: "queue.update", job: jobById(id) });
  void kickQueue();
  return jobById(id)!;
}

function jobById(id: string): JobRow | undefined {
  return db.prepare("SELECT * FROM queue_jobs WHERE id=?").get(id) as unknown as JobRow | undefined;
}

const inFlight = new Set<string>(); // bot ids currently running

export async function kickQueue(): Promise<void> {
  const pending = db.prepare("SELECT * FROM queue_jobs WHERE status='pending' ORDER BY created_at").all() as unknown as JobRow[];
  for (const job of pending) {
    if (inFlight.has(job.bot_id)) continue;
    const bot = getBot(job.bot_id);
    if (!bot || bot.status !== "active") continue;
    void runJob(job.id);
  }
}

async function runJob(jobId: string): Promise<void> {
  const job = jobById(jobId);
  if (!job || job.status !== "pending") return;
  db.prepare("UPDATE queue_jobs SET status='running' WHERE id=?").run(jobId);
  broadcast({ type: "queue.update", job: jobById(jobId) });
  inFlight.add(job.bot_id);
  try {
    const conv = db.prepare("SELECT * FROM conversations WHERE id=?").get(job.conversation_id) as unknown as { kind: string } | undefined;
    if (!conv) throw new Error("conversation missing");
    if (conv.kind === "channel") {
      const members = db.prepare("SELECT bot_id FROM channel_members WHERE conversation_id=?").all(job.conversation_id) as { bot_id: string }[];
      for (const member of members) {
        const bot = getBot(member.bot_id);
        if (!bot || bot.status !== "active") continue;
        const res = await runAgent({
          botId: member.bot_id,
          conversationId: job.conversation_id,
          history: historyForProvider(job.conversation_id),
          depth: 0,
          visited: [member.bot_id],
          jobId,
        });
        broadcast({ type: "chat.message", conversationId: job.conversation_id, botId: member.bot_id, role: "assistant", content: res.text });
      }
    } else {
      const res = await runAgent({
        botId: job.bot_id,
        conversationId: job.conversation_id,
        history: historyForProvider(job.conversation_id),
        depth: 0,
        visited: [job.bot_id],
        jobId,
      });
      broadcast({ type: "chat.message", conversationId: job.conversation_id, botId: job.bot_id, role: "assistant", content: res.text });
    }
    db.prepare("UPDATE queue_jobs SET status='done', result=?, finished_at=? WHERE id=?").run("", now(), jobId);
    if (job.source === "routine") db.prepare("UPDATE routines SET failure_count=0 WHERE bot_id=?").run(job.bot_id);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    db.prepare("UPDATE queue_jobs SET status='error', result=?, finished_at=? WHERE id=?").run(msg, now(), jobId);
    if (job.source === "routine") {
      db.prepare("UPDATE routines SET failure_count=failure_count+1 WHERE bot_id=?").run(job.bot_id);
      const f = db.prepare("SELECT failure_count FROM routines WHERE bot_id=? ORDER BY created_at DESC LIMIT 1").get(job.bot_id) as { failure_count: number } | undefined;
      if (f && f.failure_count >= 10) db.prepare("UPDATE routines SET enabled=0 WHERE bot_id=?").run(job.bot_id);
    }
    broadcast({ type: "chat.error", jobId, conversationId: job.conversation_id, error: msg });
  } finally {
    inFlight.delete(job.bot_id);
    broadcast({ type: "queue.update", job: jobById(jobId) });
    void kickQueue();
  }
}

export function cancelJob(jobId: string): boolean {
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
