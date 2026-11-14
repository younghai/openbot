import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Hono } from "hono";
import { z } from "zod";
import { db } from "../db.js";
import { MEMORY_DIR } from "../config.js";
import { workspaceFor, ensureWorkspace } from "../computers/index.js";
import { safeWorkspacePath } from "../tools/gateway.js";
import { audit } from "../tools/gateway.js";
import { listCheckpoints, restoreCheckpoint, deleteCheckpoint } from "../checkpoints.js";
import type { BotRow, ComputerRow } from "../db.js";

/**
 * Files workspace: browse/preview/edit computer workspaces and the Markdown
 * memory layer (data/memory), plus checkpoint list/restore. All paths are
 * confined by the same workspace guard the tools use.
 */

export const filesRouter = new Hono();

function resolveScope(scope: string, computerId: string | undefined, botId: string | undefined): string {
  if (scope === "memory") return MEMORY_DIR;
  const computer = computerId
    ? (db.prepare("SELECT * FROM computers WHERE id=?").get(computerId) as unknown as ComputerRow | undefined)
    : defaultComputer();
  if (!computer) throw new Error("computer not found");
  const bot = botId ? (db.prepare("SELECT * FROM bots WHERE id=?").get(botId) as unknown as BotRow | undefined) : undefined;
  return ensureWorkspace(workspaceFor(computer, bot?.id ?? "team"));
}

function defaultComputer(): ComputerRow | undefined {
  const existing = db.prepare("SELECT * FROM computers WHERE kind='team' ORDER BY created_at LIMIT 1").get() as unknown as ComputerRow | undefined;
  return existing ?? (db.prepare("SELECT * FROM computers ORDER BY created_at LIMIT 1").get() as unknown as ComputerRow | undefined);
}

filesRouter.get("/files", (c) => {
  try {
    const root = resolveScope(c.req.query("scope") ?? "memory", c.req.query("computerId") || undefined, c.req.query("botId") || undefined);
    const sub = c.req.query("path") ?? "";
    const dir = sub ? safeWorkspacePath(root, sub) : root;
    const entries = fs.readdirSync(dir, { withFileTypes: true }).map((e) => ({
      name: e.name,
      type: e.isDirectory() ? "dir" : "file",
      size: e.isDirectory() ? 0 : fs.statSync(path.join(dir, e.name)).size,
    }));
    entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
    return c.json({ path: sub, entries });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

filesRouter.get("/files/content", (c) => {
  try {
    const root = resolveScope(c.req.query("scope") ?? "memory", c.req.query("computerId") || undefined, c.req.query("botId") || undefined);
    const file = safeWorkspacePath(root, c.req.query("path") ?? "");
    const stat = fs.statSync(file);
    if (stat.size > 200_000) return c.json({ error: "file too large to preview (max 200KB)" }, 413);
    const ext = path.extname(file).toLowerCase();
    if ([".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(ext)) {
      const mime = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : ext === ".gif" ? "image/gif" : "image/jpeg";
      return new Response(new Uint8Array(fs.readFileSync(file)), { headers: { "content-type": mime } });
    }
    return c.json({ path: c.req.query("path"), content: fs.readFileSync(file, "utf8") });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

const SaveFile = z.object({
  scope: z.enum(["memory", "workspace"]).default("memory"),
  computerId: z.string().optional(),
  botId: z.string().optional(),
  path: z.string().min(1).max(300),
  content: z.string().max(200_000),
});

filesRouter.put("/files/content", async (c) => {
  const parsed = SaveFile.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "invalid body", issues: parsed.error.issues.slice(0, 3) }, 400);
  try {
    const { scope, computerId, botId, path: rel, content } = parsed.data;
    const root = resolveScope(scope, computerId, botId);
    const file = safeWorkspacePath(root, rel);
    await fsp.writeFile(file, content, "utf8");
    audit(null, "fs.write", { via: "files-ui", path: rel }, "allow", `user edit via Files view (${scope})`);
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

// ---------------------------------------------------------------- checkpoints

filesRouter.get("/checkpoints", (c) => c.json(listCheckpoints(c.req.query("workspace") || undefined)));

filesRouter.post("/checkpoints/:id/restore", (c) => {
  const r = restoreCheckpoint(c.req.param("id"));
  return c.json(r, r.ok ? 200 : 400);
});

filesRouter.delete("/checkpoints/:id", (c) => {
  deleteCheckpoint(c.req.param("id"));
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- knowledge (RAG)

import { KNOWLEDGE_DIR } from "../knowledge.js";
import { indexFile, listKnowledge, removeKnowledge, searchKnowledgeAsync } from "../knowledge.js";

filesRouter.get("/knowledge", (c) => {
  const botId = c.req.query("botId") ?? "";
  return c.json({ documents: listKnowledge(botId) });
});

filesRouter.post("/knowledge/index", async (c) => {
  const body = await c.req.json<{ botId: string; path: string }>();
  const n = indexFile(body.botId, body.path);
  return c.json({ chunks: n }, n > 0 ? 200 : 400);
});

filesRouter.delete("/knowledge/:botId/:source", (c) => {
  removeKnowledge(c.req.param("botId"), decodeURIComponent(c.req.param("source")));
  return c.json({ ok: true });
});

filesRouter.get("/knowledge/search", async (c) => {
  const botId = c.req.query("botId") ?? "";
  const q = c.req.query("q") ?? "";
  return c.json({ results: await searchKnowledgeAsync(botId, q, 5) });
});

// channel status endpoint (P1-H)
filesRouter.get("/channel-status", async (c) => {
  const { credentialFor } = await import("../voice.js");
  return c.json({
    telegram: Boolean(credentialFor("TELEGRAM_BOT_TOKEN")),
    discord: Boolean(credentialFor("DISCORD_BOT_TOKEN")),
    slack: Boolean(credentialFor("SLACK_BOT_TOKEN") && credentialFor("SLACK_APP_TOKEN")),
    email: Boolean(credentialFor("SMTP_HOST") && credentialFor("SMTP_USER")),
    phone: Boolean(credentialFor("TWILIO_ACCOUNT_SID")),
    payment: Boolean(credentialFor("STRIPE_SECRET_KEY")),
  });
});
