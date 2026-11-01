import { Hono } from "hono";
import { z } from "zod";
import { db, uid, now } from "../db.js";
import { getOrCreateDmConversation, insertMessage } from "../agent/loop.js";
import { enqueueJob } from "../queue.js";
import { broadcast } from "../events.js";
import { notify } from "../notifications.js";

/**
 * Task board: tasks are first-class work items a bot can own. "run" hands the
 * task to the assignee bot as a queue job; the bot reports back with the
 * task.update tool, which flips the board card.
 */

export const tasksRouter = new Hono();

const STATUSES = ["backlog", "doing", "review", "done"] as const;

const CreateTask = z.object({
  title: z.string().trim().min(1).max(300),
  detail: z.string().max(4000).optional(),
  assigneeBotId: z.string().optional(),
  dueAt: z.number().int().optional(),
});

const PatchTask = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  detail: z.string().max(4000).optional(),
  status: z.enum(STATUSES).optional(),
  assigneeBotId: z.string().nullable().optional(),
  dueAt: z.number().int().nullable().optional(),
});

export function taskWithBot(row: Record<string, unknown>): Record<string, unknown> {
  const bot = row.assignee_bot_id
    ? (db.prepare("SELECT emoji, name FROM bots WHERE id=?").get(String(row.assignee_bot_id)) as { emoji: string; name: string } | undefined)
    : undefined;
  return { ...row, activity: JSON.parse(String(row.activity ?? "[]")), assignee: bot ?? null };
}

export function broadcastTask(id: string): void {
  const row = db.prepare("SELECT * FROM tasks WHERE id=?").get(id) as Record<string, unknown> | undefined;
  if (row) broadcast({ type: "task.updated", task: taskWithBot(row) });
}

function appendActivity(id: string, by: string, text: string): void {
  const row = db.prepare("SELECT activity FROM tasks WHERE id=?").get(String(id)) as { activity: string } | undefined;
  if (!row) return;
  const list = JSON.parse(row.activity || "[]") as unknown[];
  list.push({ at: now(), by, text: text.slice(0, 500) });
  db.prepare("UPDATE tasks SET activity=?, updated_at=? WHERE id=?").run(JSON.stringify(list).slice(0, 20_000), now(), id);
}

tasksRouter.post("/tasks", async (c) => {
  const parsed = CreateTask.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "title required", issues: parsed.error.issues.slice(0, 3) }, 400);
  const { title, detail, assigneeBotId, dueAt } = parsed.data;
  if (assigneeBotId && !db.prepare("SELECT 1 FROM bots WHERE id=?").get(assigneeBotId)) {
    return c.json({ error: "unknown assignee bot" }, 400);
  }
  const id = uid();
  db.prepare("INSERT INTO tasks (id, title, detail, status, assignee_bot_id, due_at, activity, created_at, updated_at) VALUES (?,?,?,'backlog',?,?, '[]', ?, ?)").run(
    id, title, detail ?? "", assigneeBotId ?? null, dueAt ?? null, now(), now()
  );
  appendActivity(id, "user", "작업 생성");
  broadcastTask(id);
  return c.json({ id }, 201);
});

tasksRouter.get("/tasks", (c) => {
  const rows = db.prepare("SELECT * FROM tasks ORDER BY updated_at DESC LIMIT 300").all() as unknown as Record<string, unknown>[];
  return c.json(rows.map(taskWithBot));
});

tasksRouter.patch("/tasks/:id", async (c) => {
  const parsed = PatchTask.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "invalid body", issues: parsed.error.issues.slice(0, 3) }, 400);
  const id = c.req.param("id");
  const row = db.prepare("SELECT * FROM tasks WHERE id=?").get(id) as Record<string, unknown> | undefined;
  if (!row) return c.json({ error: "task not found" }, 404);
  const b = parsed.data;
  if (b.title !== undefined) db.prepare("UPDATE tasks SET title=? WHERE id=?").run(b.title, id);
  if (b.detail !== undefined) db.prepare("UPDATE tasks SET detail=? WHERE id=?").run(b.detail, id);
  if (b.dueAt !== undefined) db.prepare("UPDATE tasks SET due_at=? WHERE id=?").run(b.dueAt, id);
  if (b.assigneeBotId !== undefined) db.prepare("UPDATE tasks SET assignee_bot_id=? WHERE id=?").run(b.assigneeBotId, id);
  if (b.status !== undefined && b.status !== row.status) {
    db.prepare("UPDATE tasks SET status=?, completed_at=? WHERE id=?").run(b.status, b.status === "done" ? now() : null, id);
    appendActivity(id, "user", `상태 ${String(row.status)} → ${b.status}`);
    const bot = b.assigneeBotId ?? (row.assignee_bot_id as string | null);
    if (b.status === "done" || b.status === "review") {
      notify("task", `작업 '${String(row.title).slice(0, 60)}' ${b.status === "done" ? "완료" : "검토 요청"}`, bot ? `담당 봇: ${bot.slice(0, 8)}` : "");
    }
  }
  db.prepare("UPDATE tasks SET updated_at=? WHERE id=?").run(now(), id);
  broadcastTask(id);
  return c.json({ ok: true });
});

tasksRouter.delete("/tasks/:id", (c) => {
  db.prepare("DELETE FROM tasks WHERE id=?").run(c.req.param("id"));
  broadcast({ type: "task.updated", task: null, deleted: c.req.param("id") });
  return c.json({ ok: true });
});

/** Hand the task to its assignee bot as a queue job; the bot reports back via task.update. */
tasksRouter.post("/tasks/:id/run", async (c) => {
  const id = c.req.param("id");
  const row = db.prepare("SELECT * FROM tasks WHERE id=?").get(id) as Record<string, unknown> | undefined;
  if (!row) return c.json({ error: "task not found" }, 404);
  const botId = row.assignee_bot_id as string | null;
  if (!botId) return c.json({ error: "task has no assignee bot" }, 400);
  const bot = db.prepare("SELECT name FROM bots WHERE id=?").get(botId) as { name: string } | undefined;
  if (!bot) return c.json({ error: "assignee bot not found" }, 400);
  const conv = getOrCreateDmConversation(botId);
  const prompt = `[TASK ${id.slice(0, 8)}] ${String(row.title)}\n${String(row.detail ?? "")}\n— 이 작업을 수행하고, 완료하면 task.update 도구로 status='done', note에 결과 요약을 남겨라. 진행 중이면 'doing'으로 바꿔라.`;
  insertMessage(conv.id, botId, "user", prompt, { meta: { source: "task", taskId: id } });
  broadcast({ type: "chat.message", conversationId: conv.id, botId, role: "user", content: prompt });
  const job = enqueueJob(botId, conv.id, prompt, "task");
  db.prepare("UPDATE tasks SET status='doing', updated_at=? WHERE id=?").run(now(), id);
  appendActivity(id, "user", `${bot.name}에게 실행 지시`);
  broadcastTask(id);
  return c.json({ jobId: job.id, conversationId: conv.id }, 202);
});
