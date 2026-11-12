import { Hono } from "hono";
import { z } from "zod";
import { db, uid, now } from "../db.js";

/**
 * Engagement routes (Open WebUI pattern): message feedback (👍/👎),
 * prompt library, bot pin/hide. All additive — no existing table changes.
 */

export const engagementRouter = new Hono();

// ---------------------------------------------------------------- message feedback (P1-B)

engagementRouter.post("/feedback", async (c) => {
  const body = await c.req.json<{ messageId?: string; conversationId?: string; botId?: string; rating?: string }>();
  const messageId = String(body.messageId ?? "");
  const rating = String(body.rating ?? "");
  if (!messageId || !["up", "down"].includes(rating)) {
    return c.json({ error: "messageId and rating (up|down) required" }, 400);
  }
  // toggle: if same rating exists, remove it
  const existing = db.prepare("SELECT id FROM message_feedback WHERE message_id=? AND rating=?").get(messageId, rating) as { id: string } | undefined;
  if (existing) {
    db.prepare("DELETE FROM message_feedback WHERE id=?").run(existing.id);
    return c.json({ ok: true, removed: true });
  }
  db.prepare("INSERT INTO message_feedback (id, message_id, conversation_id, bot_id, rating, created_at) VALUES (?,?,?,?,?,?)").run(
    uid(), messageId, String(body.conversationId ?? ""), body.botId ? String(body.botId) : null, rating, now()
  );
  return c.json({ ok: true, rating });
});

engagementRouter.get("/feedback/stats", (c) => {
  const rows = db.prepare(`
    SELECT mf.bot_id, b.name as bot_name, b.emoji,
      SUM(CASE WHEN mf.rating='up' THEN 1 ELSE 0 END) as thumbs_up,
      SUM(CASE WHEN mf.rating='down' THEN 1 ELSE 0 END) as thumbs_down,
      COUNT(*) as total
    FROM message_feedback mf
    LEFT JOIN bots b ON b.id = mf.bot_id
    GROUP BY mf.bot_id
    ORDER BY total DESC
  `).all();
  return c.json(rows);
});

// ---------------------------------------------------------------- prompt library (P1-C)

engagementRouter.get("/prompts", (c) => {
  return c.json(db.prepare("SELECT * FROM prompts ORDER BY created_at DESC").all());
});

engagementRouter.post("/prompts", async (c) => {
  const body = await c.req.json<{ title?: string; content?: string }>();
  const title = String(body.title ?? "").trim();
  const content = String(body.content ?? "").trim();
  if (!title || !content) return c.json({ error: "title and content required" }, 400);
  const id = uid();
  db.prepare("INSERT INTO prompts (id, title, content, created_at) VALUES (?,?,?,?)").run(id, title.slice(0, 100), content.slice(0, 8000), now());
  return c.json({ id }, 201);
});

engagementRouter.delete("/prompts/:id", (c) => {
  db.prepare("DELETE FROM prompts WHERE id=?").run(c.req.param("id"));
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- bot pin/hide (P1-E)

engagementRouter.patch("/bots/:id/pin", async (c) => {
  const body = await c.req.json<{ pinned?: boolean }>();
  db.prepare("UPDATE bots SET pinned=? WHERE id=?").run(body.pinned ? 1 : 0, c.req.param("id"));
  return c.json({ ok: true, pinned: body.pinned ? 1 : 0 });
});

engagementRouter.patch("/bots/:id/hide", async (c) => {
  const body = await c.req.json<{ hidden?: boolean }>();
  db.prepare("UPDATE bots SET hidden=? WHERE id=?").run(body.hidden ? 1 : 0, c.req.param("id"));
  return c.json({ ok: true, hidden: body.hidden ? 1 : 0 });
});
