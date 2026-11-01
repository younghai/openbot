import { Hono } from "hono";
import { z } from "zod";
import { db, uid, now } from "../db.js";
import { encrypt } from "../crypto.js";
import { refreshSource, invalidateSource } from "../tools/dynamic.js";
import { listApprovals, decideApproval, listToolPolicies, POLICY_PRESETS, applyPolicyPreset, currentPolicyPreset } from "../approvals.js";
import { catalogEntries } from "../tool-catalog.js";

export const sourcesRouter = new Hono();

const CreateToolSource = z.object({
  name: z.string().trim().min(1).max(60),
  kind: z.enum(["mcp", "openapi", "composio", "pipedream", "treg"]),
  url: z.string().max(1000).optional(),
  specUrl: z.string().max(1000).optional(),
  spec: z.string().max(500_000).optional(),
  baseUrl: z.string().max(500).optional(),
  headerName: z.string().max(100).optional(),
  authType: z.enum(["bearer", "apiKey"]).optional(),
  execPath: z.string().max(500).optional(),
  transport: z.enum(["http", "stdio"]).optional(),
  command: z.string().max(300).optional(),
  args: z.array(z.string().max(1000)).max(20).optional(),
  env: z.record(z.string(), z.string().max(2000)).optional(),
  apiKey: z.string().max(500).optional(),
});

sourcesRouter.post("/tool-sources", async (c) => {
  const parsed = CreateToolSource.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "invalid body", issues: parsed.error.issues.slice(0, 3) }, 400);
  const body = parsed.data;
  const config: Record<string, unknown> = {};
  for (const key of ["url", "specUrl", "spec", "baseUrl", "headerName", "authType", "execPath", "transport", "command", "args", "env"] as const) {
    const v = body[key];
    if (v !== undefined && v !== "") config[key] = v;
  }
  if (body.apiKey) {
    config.apiKeyEnc = encrypt(body.apiKey);
    if (body.kind === "treg") config.tokenEnc = encrypt(body.apiKey);
  }
  const id = uid();
  db.prepare("INSERT INTO tool_sources (id, name, kind, config, enabled, status, created_at) VALUES (?,?,?,?,1,'unverified',?)").run(
    id, body.name, body.kind, JSON.stringify(config), now()
  );
  let tools: string[] = [];
  let status = "unverified";
  let detail: string | null = null;
  try {
    const list = await refreshSource(id);
    tools = list.map((t) => t.name);
    status = "ok";
    detail = `${tools.length} tools`;
  } catch (err) {
    status = "error";
    detail = err instanceof Error ? err.message : String(err);
  }
  return c.json({ id, status, detail, tools }, 201);
});

sourcesRouter.post("/tool-sources/:id/refresh", async (c) => {
  try {
    const tools = await refreshSource(c.req.param("id"));
    return c.json({ ok: true, count: tools.length, tools: tools.map((t) => t.name) });
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 502);
  }
});

sourcesRouter.delete("/tool-sources/:id", (c) => {
  const id = c.req.param("id");
  invalidateSource(id);
  db.prepare("DELETE FROM tool_sources WHERE id=?").run(id);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- tool approvals + policies

sourcesRouter.get("/approvals", (c) => c.json(listApprovals(c.req.query("status"))));
sourcesRouter.post("/approvals/:id/approve", (c) => {
  const r = decideApproval(c.req.param("id"), "approved");
  return c.json(r, r.ok ? 200 : 409);
});
sourcesRouter.post("/approvals/:id/deny", (c) => {
  const r = decideApproval(c.req.param("id"), "denied");
  return c.json(r, r.ok ? 200 : 409);
});
sourcesRouter.get("/tool-policies", (c) => c.json(listToolPolicies()));
sourcesRouter.get("/tool-policies/presets", (c) => c.json({ presets: POLICY_PRESETS, current: currentPolicyPreset() }));
sourcesRouter.post("/tool-policies/presets/:id/apply", (c) => {
  try {
    const preset = applyPolicyPreset(c.req.param("id"));
    return c.json({ ok: true, applied: preset.id });
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

// ---------------------------------------------------------------- tool source catalog

sourcesRouter.get("/tool-catalog", (c) => c.json(catalogEntries()));
