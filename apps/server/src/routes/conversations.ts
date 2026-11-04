import { Hono } from "hono";
import { z } from "zod";
import { db, uid, now } from "../db.js";
import { getOrCreateDmConversation } from "../agent/loop.js";
import { enqueueJob, listJobs, cancelJob } from "../queue.js";
import type { ChatAttachment } from "../chat.js";

export const conversationsRouter = new Hono();

const DEFAULT_PAGE = 60;

const SendMessage = z.object({
  content: z.string().max(100_000).optional().default(""),
  attachments: z.array(z.object({
    path: z.string().max(200).regex(/^[A-Za-z0-9._-]+$/),
    name: z.string().max(200).optional(),
    contentType: z.string().max(100).optional(),
  })).max(4).optional(),
});

conversationsRouter.post("/conversations", async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  if (body.kind === "channel") {
    const title = String(body.title ?? "").trim() || "channel";
    const botIds = Array.isArray(body.botIds) ? (body.botIds as string[]) : [];
    const id = uid();
    db.prepare("INSERT INTO conversations (id, kind, title, bot_id, created_at) VALUES (?,?,?,?,?)").run(id, "channel", title, null, now());
    const ins = db.prepare("INSERT OR IGNORE INTO channel_members (conversation_id, bot_id) VALUES (?,?)");
    for (const botId of botIds) ins.run(id, botId);
    return c.json({ id, kind: "channel", title }, 201);
  }
  const botId = String(body.botId ?? "");
  const bot = db.prepare("SELECT id FROM bots WHERE id=?").get(botId);
  if (!bot) return c.json({ error: "botId required for dm" }, 400);
  const conv = getOrCreateDmConversation(botId);
  return c.json(conv, 201);
});

// Paginated: ?before=<created_at ms>&limit=<n>. Without params → latest page (ascending order kept).
conversationsRouter.get("/conversations/:id/messages", (c) => {
  const id = c.req.param("id");
  const before = Number(c.req.query("before") ?? 0);
  const limit = Math.min(Number(c.req.query("limit") ?? DEFAULT_PAGE), 200);
  const rows = before > 0
    ? (db.prepare("SELECT * FROM messages WHERE conversation_id=? AND created_at < ? ORDER BY created_at DESC LIMIT ?").all(id, before, limit) as unknown[]).reverse()
    : (db.prepare("SELECT * FROM messages WHERE conversation_id=? ORDER BY created_at DESC LIMIT ?").all(id, limit) as unknown[]).reverse();
  return c.json(rows);
});

conversationsRouter.patch("/conversations/:id/members", async (c) => {
  const id = c.req.param("id");
  const conv = db.prepare("SELECT * FROM conversations WHERE id=?").get(id) as { kind: string } | undefined;
  if (!conv || conv.kind !== "channel") return c.json({ error: "channel conversation not found" }, 404);
  const body = await c.req.json<{ botIds?: unknown }>();
  const botIds = Array.isArray(body.botIds) ? (body.botIds as string[]) : [];
  for (const botId of botIds) {
    if (!db.prepare("SELECT 1 FROM bots WHERE id=?").get(botId)) return c.json({ error: `unknown bot ${botId}` }, 400);
  }
  db.prepare("DELETE FROM channel_members WHERE conversation_id=?").run(id);
  const ins = db.prepare("INSERT OR IGNORE INTO channel_members (conversation_id, bot_id) VALUES (?,?)");
  for (const botId of botIds) ins.run(id, botId);
  return c.json({ ok: true, members: botIds.length });
});

conversationsRouter.post("/conversations/:id/messages", async (c) => {
  const convId = c.req.param("id");
  const parsed = SendMessage.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "invalid body", issues: parsed.error.issues.slice(0, 3) }, 400);
  const { content, attachments } = parsed.data;
  const conv = db.prepare("SELECT * FROM conversations WHERE id=?").get(convId) as { kind: string; bot_id: string | null } | undefined;
  if (!conv) return c.json({ error: "conversation not found" }, 404);
  if (!content.trim() && !attachments?.length) return c.json({ error: "content required" }, 400);
  const { enqueueFromHttp } = await import("../chat.js");
  const res = await enqueueFromHttp(convId, content, attachments as ChatAttachment[] | undefined);
  if (typeof res === "string" && res.startsWith("__")) {
    const steered = res.replace(/^__|$/g, "").replace(/__/g, "");
    return c.json({ jobId: null, steered }, 202);
  }
  return c.json({ jobId: res }, 202);
});

conversationsRouter.get("/audit", (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? 100), 1000);
  const botId = c.req.query("botId");
  const rows = botId
    ? db.prepare("SELECT * FROM audit_log WHERE bot_id=? ORDER BY id DESC LIMIT ?").all(botId, limit)
    : db.prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?").all(limit);
  return c.json(rows);
});

conversationsRouter.get("/queue", (c) => c.json(listJobs(100)));
conversationsRouter.post("/queue/:id/cancel", (c) => c.json({ ok: cancelJob(c.req.param("id")) }));
