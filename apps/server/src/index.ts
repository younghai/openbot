import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { ensureDirs, PORT, SKILLS_DIR, VERSION, MEDIA_DIR } from "./config.js";
import { requireAuth, wsTokenOk, AUTH_ENABLED } from "./auth.js";
import { api } from "./routes.js";
import { handleUpgrade } from "./ws.js";
import { wireDelegation } from "./agent/loop.js";
import { startRoutineScheduler } from "./routines.js";
import { kickQueue } from "./queue.js";
import { db } from "./db.js";
import { expirePendingOnBoot } from "./approvals.js";
import { startTelegramGateway } from "./telegram.js";
import { startDiscordGateway } from "./channels/discord.js";
import { startSlackGateway } from "./channels/slack.js";

ensureDirs();
seedExampleSkill();
seedDesktopSkill();
expirePendingOnBoot();
startTelegramGateway();
startDiscordGateway();
startSlackGateway();
import "./channels/email.js"; // registers email tools
import "./channels/phone.js";
import "./channels/payment.js"; // registers phone/SMS tools
wireDelegation();
startRoutineScheduler();
// orphaned 'running' jobs cannot survive a restart — fail them so the queue moves
db.prepare("UPDATE queue_jobs SET status='error', result='interrupted by server restart', finished_at=? WHERE status='running'").run(Date.now());
void kickQueue();
pruneState();
setInterval(pruneState, 24 * 60 * 60 * 1000).unref();
function pruneState(): void {
  const days = Number(process.env.STATE_RETENTION_DAYS ?? 30);
  const cutoff = Date.now() - days * 86_400_000;
  db.prepare("DELETE FROM queue_jobs WHERE finished_at IS NOT NULL AND finished_at < ?").run(cutoff);
  db.prepare("DELETE FROM audit_log WHERE created_at < ?").run(Date.now() - Math.max(days, 90) * 86_400_000);
  db.prepare("DELETE FROM notifications WHERE read_at IS NOT NULL AND created_at < ?").run(cutoff);
  // 미디어 프루닝 — 기존: browser 스크린샷·채팅 첨부가 영구 누적(디스크 고갈)
  try {
    for (const f of fs.readdirSync(MEDIA_DIR)) {
      const full = path.join(MEDIA_DIR, f);
      try {
        if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
      } catch { /* 개별 파일 실패는 무시 */ }
    }
  } catch { /* media dir 없음 */ }
}

const app = new Hono();
app.use("/api/*", requireAuth);
app.route("/api", api);
app.onError((err, c) => {
  console.error(`[openbot] ${c.req.method} ${c.req.path} failed:`, err);
  return c.json({ error: "internal error", detail: err instanceof Error ? err.message : String(err) }, 500);
});
app.get("/ws-info", (c) => c.json({ ws: "/ws" }));

// production: serve the built web client
const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/dist");
if (fs.existsSync(webDist)) {
  const { serveStatic } = await import("@hono/node-server/serve-static");
  app.use("/*", serveStatic({ root: path.relative(process.cwd(), webDist) }));
  app.get("*", (c) => {
    const index = path.join(webDist, "index.html");
    return c.html(fs.readFileSync(index, "utf8"));
  });
}

const server = serve(
  { fetch: app.fetch, port: PORT, hostname: process.env.OPENBOT_HOST ?? "127.0.0.1" },
  (info) => {
    console.log(`[openbot] v${VERSION} listening on http://localhost:${info.port} (ws: /ws)${AUTH_ENABLED ? " [auth: token required]" : ""}`);
  if (!fs.existsSync(webDist)) {
    console.log(`[openbot] web client not built yet (${webDist}); run 'pnpm dev:web' for the dev server`);
  }
});

server.on("upgrade", handleUpgrade);

function seedExampleSkill(): void {
  const dir = path.join(SKILLS_DIR, "web-research");
  const file = path.join(dir, "SKILL.md");
  if (fs.existsSync(file)) return;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    file,
    `---
name: web-research
description: Fetch a URL and summarize what the page says, citing the title
---

# Web research

1. Use the browser.fetch tool with the URL.
2. Read the returned title and text.
3. Reply with: title, 3 key points, and any numbers worth keeping.
4. If the user asks to remember it, save a memory with memory.save.
`
  );
}

function seedDesktopSkill(): void {
  const file = path.join(SKILLS_DIR, "desktop-use", "SKILL.md");
  if (fs.existsSync(file)) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `---
name: desktop-use
description: Native desktop app control via agent-desktop (accessibility tree, headless). Use desktop tools to see and operate real apps.
---

# Desktop use (agent-desktop)

1. Observe first: desktop.list_apps \u2192 desktop.snapshot {app}. The snapshot returns refs (@snapshotId:eN) with roles, names and available_actions.
2. Act on a ref: desktop.act {action, ref}. Refs belong to their snapshot \u2014 if you get STALE_REF or AMBIGUOUS_TARGET, take a NEW snapshot and use its refs. Never guess a ref.
3. Verify: after acting, re-snapshot (or pass waitFor) and check the UI changed as intended before reporting success.
4. Dense apps: snapshot with skeleton:true first, then drill in with root.
5. 헤드리스가 기본이다 \u2014 화면 포인터는 움직이지 않는다. 사용자가 보고 있는 화면을 방해하지 않는다.
6. Prerequisites: agent-desktop installed (npm i -g agent-desktop) + macOS accessibility permission (agent-desktop permissions --guide).
`);
}
