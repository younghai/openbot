import { Hono } from "hono";
import { z } from "zod";
import { db, uid, now } from "../db.js";
import { listSkills } from "../tools/core.js";

export const routinesRouter = new Hono();

const CreateRoutine = z.object({
  botId: z.string().min(1),
  cron: z.string().min(3).max(120),
  prompt: z.string().min(1).max(8000),
  name: z.string().max(120).optional(),
});

routinesRouter.post("/routines", async (c) => {
  const parsed = CreateRoutine.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "botId, cron, prompt required", issues: parsed.error.issues.slice(0, 3) }, 400);
  const { botId, cron, prompt, name } = parsed.data;
  try {
    const { parseCron } = await import("../cron.js");
    parseCron(cron);
  } catch (err) {
    return c.json({ error: `invalid cron: ${err instanceof Error ? err.message : String(err)}` }, 400);
  }
  const id = uid();
  db.prepare("INSERT INTO routines (id, bot_id, name, cron, prompt, enabled, failure_count, created_at) VALUES (?,?,?,?,?,1,0,?)").run(
    id, botId, name ?? cron, cron, prompt, now()
  );
  return c.json({ id }, 201);
});

routinesRouter.patch("/routines/:id", async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  if (body.enabled !== undefined) db.prepare("UPDATE routines SET enabled=? WHERE id=?").run(body.enabled ? 1 : 0, c.req.param("id"));
  if (typeof body.prompt === "string") db.prepare("UPDATE routines SET prompt=? WHERE id=?").run(body.prompt, c.req.param("id"));
  return c.json({ ok: true });
});

routinesRouter.delete("/routines/:id", (c) => {
  db.prepare("DELETE FROM routines WHERE id=?").run(c.req.param("id"));
  return c.json({ ok: true });
});

routinesRouter.get("/skills", (c) => c.json(listSkills()));
