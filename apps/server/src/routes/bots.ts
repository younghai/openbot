import { Hono } from "hono";
import { z } from "zod";
import { db, uid, now } from "../db.js";
import { getOrCreateDmConversation } from "../agent/loop.js";

export const botsRouter = new Hono();

const CreateBot = z.object({
  name: z.string().trim().min(1).max(60),
  emoji: z.string().max(8).optional(),
  persona: z.string().max(4000).optional(),
  providerId: z.string().optional(),
  computerId: z.string().optional(),
  ttsProvider: z.enum(["browser", "elevenlabs", "openai", "cartesia", "fish"]).optional(),
});

botsRouter.post("/bots", async (c) => {
  const parsed = CreateBot.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "invalid body", issues: parsed.error.issues.slice(0, 3) }, 400);
  const body = parsed.data;
  const id = uid();
  db.prepare("INSERT INTO bots (id, name, emoji, persona, provider_id, computer_id, tts_provider, status, created_at) VALUES (?,?,?,?,?,?,?,?,?)").run(
    id, body.name, body.emoji ?? "🤖", body.persona ?? "", body.providerId || null, body.computerId || null, body.ttsProvider ?? "browser", "active", now()
  );
  const conv = getOrCreateDmConversation(id);
  return c.json({ id, conversationId: conv.id }, 201);
});

botsRouter.patch("/bots/:id", async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  const bot = db.prepare("SELECT * FROM bots WHERE id=?").get(c.req.param("id")) as Record<string, unknown> | undefined;
  if (!bot) return c.json({ error: "bot not found" }, 404);
  const fields: Record<string, unknown> = {};
  for (const key of ["name", "emoji", "persona", "providerId", "computerId", "ttsProvider", "status"]) {
    if (body[key] !== undefined) fields[key] = body[key];
  }
  const col = (k: string): string => ({ providerId: "provider_id", computerId: "computer_id", ttsProvider: "tts_provider" } as Record<string, string>)[k] ?? k;
  const sets = Object.keys(fields).map((k) => `${col(k)}=?`).join(", ");
  if (sets) db.prepare(`UPDATE bots SET ${sets} WHERE id=?`).run(...(Object.values(fields) as (string | number | null)[]), String(bot.id));
  if (fields.status === "active") void import("../queue.js").then((m) => m.kickQueue());
  return c.json({ ok: true });
});

botsRouter.delete("/bots/:id", (c) => {
  const id = c.req.param("id");
  db.prepare("DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE bot_id=?)").run(id);
  db.prepare("DELETE FROM conversations WHERE bot_id=?").run(id);
  db.prepare("DELETE FROM memories WHERE bot_id=?").run(id);
  db.prepare("DELETE FROM routines WHERE bot_id=?").run(id);
  db.prepare("DELETE FROM queue_jobs WHERE bot_id=? AND status IN ('pending','running')").run(id);
  db.prepare("DELETE FROM channel_members WHERE bot_id=?").run(id);
  db.prepare("UPDATE tasks SET assignee_bot_id=NULL WHERE assignee_bot_id=?").run(id);
  db.prepare("DELETE FROM bots WHERE id=?").run(id);
  return c.json({ ok: true });
});

botsRouter.get("/bots/:id/memories", (c) => {
  return c.json(db.prepare("SELECT * FROM memories WHERE bot_id=? ORDER BY created_at DESC").all(c.req.param("id")));
});

botsRouter.delete("/memories/:id", (c) => {
  db.prepare("DELETE FROM memories WHERE id=?").run(c.req.param("id"));
  return c.json({ ok: true });
});
