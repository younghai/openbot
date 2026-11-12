import { Hono } from "hono";
import { z } from "zod";
import { db, uid, now } from "../db.js";
import { encrypt } from "../crypto.js";
import { providerForRow } from "../agent/providers.js";
import { MODEL_PRESETS, presetModels } from "../presets.js";

export const modelsRouter = new Hono();

const CreateProvider = z.object({
  name: z.string().trim().min(1).max(60),
  kind: z.enum(["openai-compatible", "anthropic", "mock"]),
  baseUrl: z.string().max(500).optional(),
  apiKey: z.string().max(500).optional(),
  model: z.string().trim().min(1).max(200),
  isDefault: z.boolean().optional(),
});

modelsRouter.get("/presets", (c) => c.json(MODEL_PRESETS));

modelsRouter.get("/presets/:id/models", async (c) => {
  try {
    const models = await presetModels(c.req.param("id"));
    return c.json({ ok: true, models });
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 502);
  }
});

modelsRouter.post("/providers", async (c) => {
  const parsed = CreateProvider.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "name, kind, model required", issues: parsed.error.issues.slice(0, 3) }, 400);
  const body = parsed.data;
  const id = uid();
  db.prepare("INSERT INTO model_providers (id, name, kind, base_url, api_key_enc, model, is_default, created_at) VALUES (?,?,?,?,?,?,?,?)").run(
    id, body.name, body.kind, body.baseUrl || null, body.apiKey ? encrypt(body.apiKey) : null, body.model, body.isDefault ? 1 : 0, now()
  );
  if (body.isDefault) db.prepare("UPDATE model_providers SET is_default=0 WHERE id!=?").run(id);
  return c.json({ id }, 201);
});

modelsRouter.patch("/providers/:id", async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  const id = c.req.param("id");
  const row = db.prepare("SELECT * FROM model_providers WHERE id=?").get(id);
  if (!row) return c.json({ error: "provider not found" }, 404);
  if (typeof body.name === "string") db.prepare("UPDATE model_providers SET name=? WHERE id=?").run(body.name, id);
  if (typeof body.model === "string") db.prepare("UPDATE model_providers SET model=? WHERE id=?").run(body.model, id);
  if (typeof body.baseUrl === "string") db.prepare("UPDATE model_providers SET base_url=? WHERE id=?").run(body.baseUrl, id);
  if (typeof body.apiKey === "string" && body.apiKey) db.prepare("UPDATE model_providers SET api_key_enc=? WHERE id=?").run(encrypt(body.apiKey), id);
  if (body.isDefault !== undefined) {
    if (body.isDefault) {
      db.prepare("UPDATE model_providers SET is_default=0").run();
      db.prepare("UPDATE model_providers SET is_default=1 WHERE id=?").run(id);
    } else {
      db.prepare("UPDATE model_providers SET is_default=0 WHERE id=?").run(id);
    }
  }
  return c.json({ ok: true });
});

modelsRouter.delete("/providers/:id", (c) => {
  db.prepare("UPDATE bots SET provider_id=NULL WHERE provider_id=?").run(c.req.param("id"));
  db.prepare("DELETE FROM model_providers WHERE id=?").run(c.req.param("id"));
  return c.json({ ok: true });
});

modelsRouter.post("/providers/:id/test", async (c) => {
  const row = db.prepare("SELECT * FROM model_providers WHERE id=?").get(c.req.param("id")) as import("../db.js").ProviderRow | undefined;
  if (!row) return c.json({ error: "provider not found" }, 404);
  try {
    const provider = providerForRow(row);
    const res = await provider.chat({
      messages: [{ role: "user", content: "Reply with the single word: pong" }],
      tools: [],
    });
    return c.json({ ok: true, model: res.model, reply: res.message.content?.toString().slice(0, 100) ?? "" });
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 502);
  }
});

// ---------------------------------------------------------------- Ollama model pull (P0-A)

modelsRouter.post("/presets/ollama/pull", async (c) => {
  const body = await c.req.json<{ model?: string }>();
  const model = String(body.model ?? "").trim();
  if (!model) return c.json({ error: "model required" }, 400);
  try {
    const res = await fetch("http://localhost:11434/api/pull", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, stream: false }),
      signal: AbortSignal.timeout(300_000),
    });
    if (!res.ok) return c.json({ error: `Ollama pull HTTP ${res.status}` }, 502);
    return c.json({ ok: true, model });
  } catch (err) {
    return c.json({ error: `Ollama pull failed: ${err instanceof Error ? err.message : String(err)}` }, 502);
  }
});
