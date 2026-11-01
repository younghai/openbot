import { Hono } from "hono";
import { z } from "zod";
import { db, uid, now } from "../db.js";
import { encrypt } from "../crypto.js";
import { providerStatus, providers as computerProviders } from "../computers/index.js";

export const computersRouter = new Hono();

const CreateComputer = z.object({
  name: z.string().trim().min(1).max(60),
  kind: z.enum(["team", "private"]).optional(),
  provider: z.string().max(40).optional(),
  image: z.string().max(300).optional(),
  apiUrl: z.string().max(500).optional(),
  execPath: z.string().max(500).optional(),
  bearer: z.string().max(500).optional(),
  apiKey: z.string().max(500).optional(),
});

computersRouter.post("/computers", async (c) => {
  const parsed = CreateComputer.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "invalid body", issues: parsed.error.issues.slice(0, 3) }, 400);
  const body = parsed.data;
  const kind = body.kind === "private" ? "private" : "team";
  const provider = body.provider ?? "local";
  if (!(provider in computerProviders)) return c.json({ error: `unknown provider '${provider}'` }, 400);
  const config: Record<string, unknown> = {};
  for (const key of ["image", "apiUrl", "execPath", "bearer"] as const) {
    if (body[key] !== undefined) config[key] = body[key];
  }
  if (body.apiKey) config.apiKeyEnc = encrypt(body.apiKey);
  const id = uid();
  db.prepare("INSERT INTO computers (id, name, kind, provider, config, created_at) VALUES (?,?,?,?,?,?)").run(
    id, body.name, kind, provider, JSON.stringify(config), now()
  );
  return c.json({ id }, 201);
});

computersRouter.delete("/computers/:id", (c) => {
  db.prepare("UPDATE bots SET computer_id=NULL WHERE computer_id=?").run(c.req.param("id"));
  db.prepare("DELETE FROM computers WHERE id=?").run(c.req.param("id"));
  return c.json({ ok: true });
});

computersRouter.post("/computers/:id/test", async (c) => {
  const row = db.prepare("SELECT * FROM computers WHERE id=?").get(c.req.param("id")) as { provider: string } | undefined;
  if (!row) return c.json({ error: "computer not found" }, 404);
  const status = await providerStatus(row.provider);
  return c.json(status, status.available ? 200 : 503);
});

computersRouter.get("/computer-providers", async (c) => {
  const out: Record<string, { available: boolean; detail: string }> = {};
  for (const kind of Object.keys(computerProviders)) out[kind] = await providerStatus(kind);
  return c.json(out);
});
