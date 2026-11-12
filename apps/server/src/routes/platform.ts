import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Hono } from "hono";
import { db, uid, now } from "../db.js";
import { DATA_DIR, MEDIA_DIR } from "../config.js";
import { providerStatus, providers as computerProviders } from "../computers/index.js";
import { listJobs } from "../queue.js";
import { listSkills } from "../tools/core.js";
import { cachedToolsFor } from "../tools/dynamic.js";
import { synthesize, transcribe, listCredentialStatus, setCredential, VoiceConfigError, type TtsProviderName } from "../voice.js";
import { listNotifications, markAllRead } from "../notifications.js";

export const platformRouter = new Hono();

platformRouter.get("/health", (c) => c.json({ ok: true, version: "0.1.0" }));

platformRouter.get("/bootstrap", async (c) => {
  const bots = db.prepare("SELECT * FROM bots ORDER BY created_at").all();
  const conversations = db.prepare("SELECT * FROM conversations ORDER BY created_at").all();
  const members = db.prepare("SELECT * FROM channel_members").all();
  const computers: unknown[] = [];
  for (const row of db.prepare("SELECT * FROM computers ORDER BY created_at").all() as unknown as { id: string; name: string; kind: string; provider: string; config: string; created_at: number }[]) {
    const status = await providerStatus(row.provider);
    computers.push({ ...row, config: sanitizeComputerConfig(row.config), status });
  }
  const providers = (db.prepare("SELECT * FROM model_providers ORDER BY created_at").all() as unknown as { id: string; name: string; kind: string; base_url: string | null; api_key_enc: string | null; model: string; is_default: number; created_at: number }[]).map((p) => ({
    ...p,
    api_key_enc: undefined,
    hasKey: Boolean(p.api_key_enc),
  }));
  const toolSources = (db.prepare("SELECT * FROM tool_sources ORDER BY created_at").all() as unknown as { config: string }[] & { status: string; status_detail: string | null }[]).map((s) => ({
    ...s,
    config: sanitizeSourceConfig(s),
    tools: cachedToolsFor((s as unknown as { id: string }).id).map((t) => t.name),
  }));
  const routines = db.prepare("SELECT * FROM routines ORDER BY created_at").all();
  return c.json({
    bots,
    conversations,
    channelMembers: members,
    computers,
    providers,
    toolSources,
    routines,
    jobs: listJobs(20),
    skills: listSkills(),
    credentials: listCredentialStatus(),
    computerProviderKinds: Object.keys(computerProviders),
  });
});

function sanitizeComputerConfig(config: string): Record<string, unknown> {
  const cfg = JSON.parse(config || "{}") as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(cfg)) {
    out[k] = k.toLowerCase().includes("key") || k.toLowerCase().includes("enc") ? (v ? "(set)" : undefined) : v;
  }
  return out;
}

function sanitizeSourceConfig(s: { config: string }): Record<string, unknown> {
  const cfg = JSON.parse(s.config || "{}") as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(cfg)) {
    if (k === "spec") {
      out.specLength = typeof v === "string" ? v.length : 0;
    } else {
      out[k] = k.toLowerCase().includes("key") || k.toLowerCase().includes("enc") ? (v ? "(set)" : undefined) : v;
    }
  }
  return out;
}

// ---------------------------------------------------------------- settings + voice

platformRouter.get("/settings", (c) => c.json({ credentials: listCredentialStatus() }));

platformRouter.put("/settings/credentials", async (c) => {
  const body = await c.req.json<{ key?: string; value?: string }>();
  const key = String(body.key ?? "").trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  if (!/^[A-Z0-9_]{4,64}$/.test(key)) return c.json({ error: "invalid credential key" }, 400);
  if (!body.value) {
    db.prepare("DELETE FROM credentials WHERE key=?").run(key);
    return c.json({ ok: true, deleted: true });
  }
  setCredential(key, body.value);
  if (key === "TELEGRAM_BOT_TOKEN") {
    const { ensureTelegramGateway } = await import("../telegram.js");
    ensureTelegramGateway();
  }
  return c.json({ ok: true });
});

platformRouter.post("/voice/tts", async (c) => {
  const body = await c.req.json<{ text?: string; provider?: string; voice?: string }>();
  const text = String(body.text ?? "").trim();
  const provider = (body.provider ?? "browser") as TtsProviderName;
  if (!text) return c.json({ error: "text required" }, 400);
  try {
    const { audio, contentType } = await synthesize(text, provider, body.voice);
    return new Response(new Uint8Array(audio), { headers: { "content-type": contentType } });
  } catch (err) {
    if (err instanceof VoiceConfigError) {
      return c.json({ error: err.message, fallback: "browser" }, 400);
    }
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
  }
});

platformRouter.post("/voice/stt", async (c) => {
  try {
    const form = await c.req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return c.json({ error: "file field required" }, 400);
    const text = await transcribe(file);
    return c.json({ text });
  } catch (err) {
    if (err instanceof VoiceConfigError) {
      return c.json({ error: err.message, hint: "browser dictation (Web Speech API) needs no key" }, 400);
    }
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
  }
});

// ---------------------------------------------------------------- media (screenshots, attachments)

platformRouter.get("/media/*", async (c) => {
  const rel = c.req.path.replace(/^\/api\/media\//, "");
  const file = path.resolve(MEDIA_DIR, rel);
  if (!file.startsWith(path.resolve(MEDIA_DIR) + path.sep)) return c.json({ error: "forbidden" }, 403);
  if (!fs.existsSync(file)) return c.json({ error: "not found" }, 404);
  const data = await fsp.readFile(file);
  const ext = path.extname(file).toLowerCase();
  const mime =
    ext === ".png" ? "image/png"
    : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg"
    : ext === ".webp" ? "image/webp"
    : ext === ".gif" ? "image/gif"
    : "application/octet-stream";
  return new Response(new Uint8Array(data), { headers: { "content-type": mime } });
});

platformRouter.post("/media/attachments", async (c) => {
  try {
    const form = await c.req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return c.json({ error: "file field required" }, 400);
    if (file.size > 10 * 1024 * 1024) return c.json({ error: "file too large (max 10MB)" }, 413);
    if (!(file.type.startsWith("image/"))) return c.json({ error: "only image attachments are supported for vision input" }, 400);
    const extByType: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
    const ext = extByType[file.type] ?? "png";
    const rel = `attach-${now()}-${uid().slice(0, 6)}.${ext}`;
    await fsp.writeFile(path.join(MEDIA_DIR, rel), Buffer.from(await file.arrayBuffer()));
    return c.json({ path: rel, url: `/api/media/${rel}`, name: file.name, size: file.size, contentType: file.type }, 201);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

// ---------------------------------------------------------------- backup (data sovereignty)

platformRouter.post("/backup", async (c) => {
  const dir = path.join(DATA_DIR, "backups");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `openbot-${new Date().toISOString().replace(/[:.]/g, "-")}.db`);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  // keep the 10 most recent
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".db")).sort().reverse();
  for (const old of files.slice(10)) fs.unlinkSync(path.join(dir, old));
  const size = fs.statSync(file).size;
  return c.json({ ok: true, file: path.basename(file), bytes: size }, 201);
});

// ---------------------------------------------------------------- global search

platformRouter.get("/search", async (c) => {
  const q = (c.req.query("q") ?? "").trim().slice(0, 200);
  if (q.length < 2) return c.json({ messages: [], bots: [], memories: [], tasks: [] });
  const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  const messages = db.prepare(
    `SELECT m.id, m.conversation_id AS conversationId, m.role, substr(m.content, 1, 160) AS snippet, m.created_at, c.title, c.bot_id AS botId
     FROM messages m JOIN conversations c ON c.id = m.conversation_id
     WHERE m.content LIKE ? ESCAPE '\\' AND m.role IN ('user','assistant')
     ORDER BY m.created_at DESC LIMIT 20`
  ).all(like);
  const bots = db.prepare("SELECT id, name, emoji, substr(persona, 1, 120) AS persona FROM bots WHERE name LIKE ? ESCAPE '\\' OR persona LIKE ? ESCAPE '\\' LIMIT 10").all(like, like);
  const memories = db.prepare(
    `SELECT mem.id, mem.content, mem.created_at, mem.bot_id AS botId, b.name AS botName
     FROM memories mem LEFT JOIN bots b ON b.id = mem.bot_id
     WHERE mem.content LIKE ? ESCAPE '\\' ORDER BY mem.created_at DESC LIMIT 10`
  ).all(like);
  const tasks = db.prepare("SELECT id, title, status, updated_at FROM tasks WHERE title LIKE ? ESCAPE '\\' OR detail LIKE ? ESCAPE '\\' LIMIT 10").all(like, like);
  // ReMe-style memory files (data/memory) are searchable too
  const memFiles: { path: string; snippet: string }[] = [];
  try {
    const { readdirRecursive } = await import("../memory-files.js");
    for (const f of readdirRecursive().slice(0, 500)) {
      if (f.content.includes(q)) memFiles.push({ path: f.path, snippet: f.content.slice(Math.max(0, f.content.indexOf(q) - 40), f.content.indexOf(q) + 120) });
      if (memFiles.length >= 10) break;
    }
  } catch { /* memory dir optional */ }
  return c.json({ messages, bots, memories, tasks, memoryFiles: memFiles });
});

// ---------------------------------------------------------------- fleet stats

platformRouter.get("/stats", (c) => {
  const dayAgo = now() - 86_400_000;
  const bots = db.prepare("SELECT id, name, emoji, status, pinned, hidden FROM bots ORDER BY pinned DESC, created_at").all() as { id: string; name: string; emoji: string; status: string }[];
  const msgCounts = Object.fromEntries(
    (db.prepare("SELECT bot_id, COUNT(*) n FROM messages WHERE role IN ('user','assistant') GROUP BY bot_id").all() as { bot_id: string; n: number }[]).map((r) => [r.bot_id, r.n])
  );
  const toolCounts = Object.fromEntries(
    (db.prepare("SELECT bot_id, COUNT(*) n FROM messages WHERE role='tool' GROUP BY bot_id").all() as { bot_id: string; n: number }[]).map((r) => [r.bot_id, r.n])
  );
  const jobStats = db.prepare("SELECT bot_id, status, COUNT(*) n FROM queue_jobs WHERE created_at > ? GROUP BY bot_id, status").all(dayAgo) as { bot_id: string; status: string; n: number }[];
  const routineStats = db.prepare("SELECT bot_id, SUM(enabled) enabled, SUM(failure_count) failures, COUNT(*) total FROM routines GROUP BY bot_id").all() as { bot_id: string; enabled: number; failures: number; total: number }[];
  let tokensIn = 0, tokensOut = 0;
  for (const row of db.prepare("SELECT meta FROM messages WHERE role='assistant' AND meta LIKE '%usage%'").all() as { meta: string }[]) {
    try {
      const usage = (JSON.parse(row.meta) as { usage?: { inputTokens?: number; outputTokens?: number } }).usage;
      tokensIn += usage?.inputTokens ?? 0;
      tokensOut += usage?.outputTokens ?? 0;
    } catch { /* skip malformed meta */ }
  }
  const pendingApprovals = (db.prepare("SELECT COUNT(*) n FROM approvals WHERE status='pending'").get() as { n: number }).n;
  // feedback satisfaction
  const feedback = db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN rating='up' THEN 1 ELSE 0 END), 0) as up,
           COALESCE(SUM(CASE WHEN rating='down' THEN 1 ELSE 0 END), 0) as down
    FROM message_feedback
  `).get() as { up: number; down: number };
  // tool usage pattern (top 10)
  const toolUsage = db.prepare(`
    SELECT tool_name, COUNT(*) as count FROM messages
    WHERE role='tool' AND tool_name IS NOT NULL
    GROUP BY tool_name ORDER BY count DESC LIMIT 10
  `).all() as { tool_name: string; count: number }[];
  // model token usage
  const modelUsage = db.prepare(`
    SELECT json_extract(meta, '$.model') as model,
           SUM(json_extract(meta, '$.usage.inputTokens')) as tokens_in,
           SUM(json_extract(meta, '$.usage.outputTokens')) as tokens_out
    FROM messages WHERE role='assistant' AND meta LIKE '%model%'
    GROUP BY model ORDER BY tokens_in + tokens_out DESC LIMIT 5
  `).all() as { model: string; tokens_in: number; tokens_out: number }[];
  const taskBoard = Object.fromEntries(
    (db.prepare("SELECT status, COUNT(*) n FROM tasks GROUP BY status").all() as { status: string; n: number }[]).map((r) => [r.status, r.n])
  );
  return c.json({
    bots: bots.map((b) => ({
      ...b,
      messages: msgCounts[b.id] ?? 0,
      toolCalls: toolCounts[b.id] ?? 0,
      jobs24h: jobStats.filter((j) => j.bot_id === b.id).reduce((s, j) => s + j.n, 0),
      jobsError24h: jobStats.find((j) => j.bot_id === b.id && j.status === "error")?.n ?? 0,
      routines: routineStats.find((r) => r.bot_id === b.id)?.enabled ?? 0,
      routineFailures: routineStats.find((r) => r.bot_id === b.id)?.failures ?? 0,
    })),
    totals: {
      messages: Object.values(msgCounts).reduce((s, n) => s + (n as number), 0),
      toolCalls: Object.values(toolCounts).reduce((s, n) => s + (n as number), 0),
      tokensIn, tokensOut,
      jobs24h: jobStats.reduce((s, j) => s + j.n, 0),
      pendingApprovals,
      tasks: taskBoard,
    },
    feedback: { up: feedback.up, down: feedback.down, satisfaction: feedback.up + feedback.down > 0 ? Math.round(feedback.up / (feedback.up + feedback.down) * 100) : null },
    toolUsage,
    modelUsage,
  });
});

// ---------------------------------------------------------------- notifications

platformRouter.get("/notifications", (c) => c.json(listNotifications(c.req.query("unread") === "1")));
platformRouter.post("/notifications/read-all", (c) => c.json({ ok: true, marked: markAllRead() }));

// ---------------------------------------------------------------- usage caps

platformRouter.get("/usage-caps", (c) => {
  const rows = db.prepare("SELECT uc.*, b.name as bot_name FROM usage_caps uc LEFT JOIN bots b ON b.id=uc.bot_id").all();
  return c.json(rows);
});

platformRouter.put("/usage-caps/:botId", async (c) => {
  const body = await c.req.json<{ dailyTokenCap?: number; monthlyTokenCap?: number; enabled?: boolean }>();
  const botId = c.req.param("botId");
  if (!db.prepare("SELECT 1 FROM bots WHERE id=?").get(botId)) return c.json({ error: "bot not found" }, 404);
  db.prepare("INSERT INTO usage_caps (bot_id, daily_token_cap, monthly_token_cap, enabled) VALUES (?,?,?,?) ON CONFLICT(bot_id) DO UPDATE SET daily_token_cap=excluded.daily_token_cap, monthly_token_cap=excluded.monthly_token_cap, enabled=excluded.enabled").run(
    botId, body.dailyTokenCap ?? null, body.monthlyTokenCap ?? null, body.enabled ? 1 : 0
  );
  return c.json({ ok: true });
});
