import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startFixtures } from "./fixtures.js";

/**
 * End-to-end verification matrix. Spawns the real server on a temp data dir and a
 * fixture host (fake OpenAI-compatible model + petstore + MCP server), then proves
 * each mandatory feature through the HTTP surface. Exit 0 = all pass.
 */

const PORT = 8900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const here = path.dirname(fileURLToPath(import.meta.url));

const results: { name: string; pass: boolean; evidence: string }[] = [];
let server: ChildProcess | null = null;
let dataDir = "";
const fixture = await startFixtures();

function record(name: string, pass: boolean, evidence: string): void {
  results.push({ name, pass, evidence });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}  —  ${evidence.slice(0, 220)}`);
}

async function api(p: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE}${p}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* keep raw */
  }
  return { status: res.status, body };
}

async function startServer(): Promise<void> {
  const tsxBin = path.resolve(here, "../../node_modules/.bin/tsx");
  server = spawn(tsxBin, [path.join(here, "..", "index.ts")], {
    cwd: here,
    env: { ...process.env, OPENBOT_PORT: String(PORT), OPENBOT_HOST: "127.0.0.1", OPENBOT_DATA_DIR: dataDir, TELEGRAM_API_BASE: `http://127.0.0.1:${fixture.port}/tg` },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  server.stderr?.on("data", (d: Buffer) => process.env.MATRIX_VERBOSE && console.error(String(d)));
  const ok = await waitFor(async () => {
    try {
      const r = await fetch(`${BASE}/api/health`);
      return r.ok;
    } catch {
      return false;
    }
  }, 20_000, "server boot");
  if (!ok) {
    const err = "server failed to boot within 20s (is a zombie holding the port?)";
    console.error(err);
    process.exit(2);
  }
}

async function stopServer(): Promise<void> {
  if (!server) return;
  try {
    process.kill(-server.pid!, "SIGKILL"); // kill the whole process group
  } catch {
    server.kill("SIGKILL");
  }
  await new Promise((r) => setTimeout(r, 300));
  server = null;
}

async function waitFor(pred: () => Promise<boolean>, timeoutMs: number, label: string): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await approvePending();
    if (await pred()) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

// the matrix acts as the approving human for tools whose policy is 'ask'
let autoApprove = true;
async function approvePending(): Promise<void> {
  if (!autoApprove) return;
  try {
    const r = await api("/api/approvals?status=pending");
    for (const a of Array.isArray(r.body) ? (r.body as { id: string }[]) : []) {
      await api(`/api/approvals/${a.id}/approve`, { method: "POST" });
    }
  } catch {
    // server not up yet / between restarts — nothing to approve
  }
}

async function waitJobDone(jobId: string, timeoutMs = 120_000): Promise<"done" | "error" | "timeout"> {
  const ok = await waitFor(async () => {
    const r = await api(`/api/queue`);
    const job = (r.body as any[]).find((j) => j.id === jobId);
    return job && (job.status === "done" || job.status === "error");
  }, timeoutMs, `job ${jobId}`);
  if (!ok) return "timeout";
  const r = await api(`/api/queue`);
  const job = (r.body as any[]).find((j) => j.id === jobId);
  return job.status;
}

async function messagesOf(convId: string): Promise<any[]> {
  const r = await api(`/api/conversations/${convId}/messages`);
  return r.body as any[];
}

async function send(convId: string, content: string): Promise<{ jobId: string; status: "done" | "error" | "timeout" }> {
  const r = await api(`/api/conversations/${convId}/messages`, { method: "POST", body: JSON.stringify({ content }) });
  const jobId = r.body.jobId;
  const status = await waitJobDone(jobId);
  return { jobId, status };
}

// ---------------------------------------------------------------- run

dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openbot-matrix-"));
process.on("uncaughtException", async (err) => {
  console.error("UNCAUGHT:", err);
  await teardown(1);
});
process.on("SIGINT", async () => {
  await teardown(130);
});
await startServer();

// 1. health/bootstrap
{
  const r = await api("/api/health");
  record("health", r.status === 200 && r.body.ok === true, JSON.stringify(r.body));
}

// 2. bot create + mock chat roundtrip
let alphaId = "", alphaConv = "";
{
  const r = await api("/api/bots", { method: "POST", body: JSON.stringify({ name: "Alpha", emoji: "🤖", persona: "친절한 조수" }) });
  alphaId = r.body.id;
  alphaConv = r.body.conversationId;
  const s = await send(alphaConv, "안녕");
  const msgs = await messagesOf(alphaConv);
  const reply = msgs.find((m) => m.role === "assistant");
  record("mock chat roundtrip", s.status === "done" && Boolean(reply), `status=${s.status} reply=${reply?.content?.slice(0, 60)}`);
}

// 3. tool loop: terminal.exec via mock
{
  const s = await send(alphaConv, "terminal 로 run 해줘");
  const msgs = await messagesOf(alphaConv);
  const toolMsg = msgs.find((m) => m.role === "tool" && m.tool_name === "terminal.exec");
  const result = toolMsg ? JSON.parse(toolMsg.tool_result) : null;
  record("terminal tool loop", s.status === "done" && toolMsg && result?.exitCode === 0, `stdout="${result?.stdout?.trim().slice(0, 50)}" exit=${result?.exitCode}`);
}

// 3b/3c. approval queue: side-effect tools wait for a human decision before running
{
  const r = await api("/api/bots", { method: "POST", body: JSON.stringify({ name: "Guard", emoji: "🛡" }) });
  const gConv = r.body.conversationId as string;
  autoApprove = false;

  const p1 = await api(`/api/conversations/${gConv}/messages`, { method: "POST", body: JSON.stringify({ content: "terminal 로 run 해줘" }) });
  const pending1 = await waitFor(async () => {
    const a = await api("/api/approvals?status=pending");
    return Array.isArray(a.body) && a.body.length > 0;
  }, 15_000, "approval appears");
  const row1 = ((await api("/api/approvals?status=pending")).body as any[])[0];
  const notExecutedYet = (await messagesOf(gConv)).every((m) => m.role !== "tool");
  const ap = await api(`/api/approvals/${row1.id}/approve`, { method: "POST" });
  const d1 = await waitJobDone(p1.body.jobId, 30_000);
  const toolOk1 = (await messagesOf(gConv)).find((m) => m.role === "tool" && m.tool_name === "terminal.exec");
  const res1 = toolOk1 ? JSON.parse(toolOk1.tool_result) : null;
  record("approval queue: ask→approve runs the tool",
    pending1 && notExecutedYet && ap.status === 200 && d1 === "done" && res1?.exitCode === 0,
    `pending=${pending1} blocked-before-approval=${notExecutedYet} approve=${ap.status} job=${d1} exit=${res1?.exitCode}`);

  const p2 = await api(`/api/conversations/${gConv}/messages`, { method: "POST", body: JSON.stringify({ content: "terminal 로 run 해줘" }) });
  await waitFor(async () => {
    const a = await api("/api/approvals?status=pending");
    return Array.isArray(a.body) && a.body.length > 0;
  }, 15_000, "second approval appears");
  const row2 = ((await api("/api/approvals?status=pending")).body as any[])[0];
  const dn = await api(`/api/approvals/${row2.id}/deny`, { method: "POST" });
  const d2 = await waitJobDone(p2.body.jobId, 30_000);
  const deniedTool = [...(await messagesOf(gConv))].reverse().find((m) => m.role === "tool" && m.tool_name === "terminal.exec" && JSON.parse(m.tool_result ?? "{}").error);
  const deniedRes = deniedTool ? JSON.parse(deniedTool.tool_result) : null;
  const audit = await api("/api/audit?limit=50");
  const denyRow = (audit.body as any[]).find((a) => a.decision === "deny" && a.tool === "terminal.exec" && /denied/.test(a.detail ?? ""));
  record("approval queue: deny blocks execution + audits",
    dn.status === 200 && d2 === "done" && String(deniedRes?.error ?? "").includes("denied") && Boolean(denyRow),
    `deny=${dn.status} job=${d2} toolResult="${String(deniedRes?.error).slice(0, 50)}" auditDeny=${Boolean(denyRow)}`);

  autoApprove = true;
}

// 4. memory via mock
{
  await send(alphaConv, "이것 좀 remember 해줘: 사용자는 커피를 좋아함");
  const r = await api(`/api/bots/${alphaId}/memories`);
  const mem = (r.body as any[]).find((m) => m.content.includes("커피"));
  record("memory save+list", Boolean(mem), `memories=${(r.body as any[]).length} latest="${mem?.content?.slice(0, 50)}"`);
}

// 5. browser.fetch real internet
{
  const s = await send(alphaConv, "https://example.com fetch 해줘");
  const msgs = await messagesOf(alphaConv);
  const toolMsg = msgs.reverse().find((m) => m.role === "tool" && m.tool_name === "browser.fetch");
  const result = toolMsg ? JSON.parse(toolMsg.tool_result) : null;
  record("browser.fetch (internet)", Boolean(result?.title?.includes("Example Domain")), `title="${result?.title}" status=${result?.status}`);
}

// 6. computer isolation: team shared vs private
let teamComputerId = "";
{
  const r = await api("/api/computers", { method: "POST", body: JSON.stringify({ name: "TeamBox", kind: "team", provider: "local" }) });
  teamComputerId = r.body.id;
  await api("/api/bots/" + alphaId, { method: "PATCH", body: JSON.stringify({ computerId: teamComputerId }) });
  const pb = await api("/api/computers", { method: "POST", body: JSON.stringify({ name: "BetaBox", kind: "private", provider: "local" }) });
  const beta = await api("/api/bots", { method: "POST", body: JSON.stringify({ name: "Beta", emoji: "🐱", computerId: pb.body.id }) });
  const betaConv = beta.body.conversationId;
  await send(alphaConv, "terminal 로 run 해줘");
  await send(betaConv, "terminal 로 run 해줘");
  const alphaMsgs = await messagesOf(alphaConv);
  const betaMsgs = await messagesOf(betaConv);
  const pwdOf = (msgs: any[]) => JSON.parse(msgs.reverse().find((m: any) => m.tool_name === "terminal.exec")?.tool_result ?? "{}")?.stdout?.trim();
  const aPwd = pwdOf(alphaMsgs);
  const bPwd = pwdOf(betaMsgs);
  const isolated = aPwd?.includes("team-") && bPwd?.includes("private-") && aPwd !== bPwd;
  record("computer isolation (team vs private)", Boolean(isolated), `alpha=${aPwd} beta=${bPwd}`);
}

// 7. docker provider unavailable message
{
  const r = await api("/api/computers", { method: "POST", body: JSON.stringify({ name: "SandboxBox", kind: "team", provider: "docker" }) });
  const t = await api(`/api/computers/${r.body.id}/test`, { method: "POST" });
  record("docker provider graceful unavailability", t.status === 503 && /docker/.test(t.body?.detail ?? ""), `create=${r.status} test=${t.status} detail="${t.body?.detail}"`);
}

// 8. remote providers status detail
{
  const r = await api("/api/computer-providers");
  const e2b = r.body.e2b;
  const local = r.body.local;
  record("provider registry (local ok + e2b needs key)", local.available === true && e2b.available === false && /E2B_API_KEY/.test(e2b.detail), `local=${local.available} e2b detail="${e2b.detail}"`);
}

// 9. delegation to peer bot
let workerId = "";
{
  const w = await api("/api/bots", { method: "POST", body: JSON.stringify({ name: "Worker", emoji: "👷" }) });
  workerId = w.body.id;
  const s = await send(alphaConv, "delegate 로 @Worker 에게 '인사해줘' 시켜줘");
  const workerMsgs = await messagesOf(w.body.conversationId);
  const delegated = workerMsgs.find((m) => m.role === "user" && m.content.includes("[delegated by Alpha]"));
  const alphaMsgs = await messagesOf(alphaConv);
  const toolMsg = alphaMsgs.reverse().find((m) => m.role === "tool" && m.tool_name === "bot.delegate");
  record("peer bot delegation", s.status === "done" && Boolean(delegated) && Boolean(toolMsg), `worker got="${delegated?.content?.slice(0, 40)}" tool=${Boolean(toolMsg)}`);
}

// 10. subagent
{
  const s = await send(alphaConv, "subagent 로 간단히 조사해줘");
  const msgs = await messagesOf(alphaConv);
  const toolMsg = msgs.reverse().find((m) => m.role === "tool" && m.tool_name === "subagent.run");
  record("subagent spawn", s.status === "done" && Boolean(toolMsg), `tool=${Boolean(toolMsg)} result=${toolMsg?.tool_result?.slice(0, 60)}`);
}

// 11. channel with two bots
{
  const ch = await api("/api/conversations", { method: "POST", body: JSON.stringify({ kind: "channel", title: "배포팀", botIds: [alphaId, workerId] }) });
  const s = await send(ch.body.id, "다들 한마디씩 인사해줘");
  const msgs = await messagesOf(ch.body.id);
  const replies = msgs.filter((m) => m.role === "assistant");
  const distinctBots = new Set(replies.map((m) => m.bot_id));
  record("shared channel (2 bots reply)", s.status === "done" && distinctBots.size >= 2, `assistant msgs=${replies.length} distinct bots=${distinctBots.size}`);
}

// 11.5 create the routine NOW so the minute boundary can pass while later tests run
{
  const rr = await api("/api/routines", { method: "POST", body: JSON.stringify({ botId: workerId, name: "정시 인사", cron: "* * * * *", prompt: "루틴 테스트: 한 줄 인사" }) });
  record("routine created", rr.status === 201, `id=${rr.body.id}`);
}

// 12. queue pause/resume
{
  await api(`/api/bots/${workerId}`, { method: "PATCH", body: JSON.stringify({ status: "paused" }) });
  const w = await api(`/api/bots/${workerId}/memories`); // noop fetch keeps connection warm
  void w;
  const workerConv = (await api("/api/bootstrap")).body.conversations.find((c: any) => c.kind === "dm" && c.bot_id === workerId).id;
  const r = await api(`/api/conversations/${workerConv}/messages`, { method: "POST", body: JSON.stringify({ content: "일시정지 상태 테스트" }) });
  const held = await waitFor(async () => {
    const q = await api("/api/queue");
    return (q.body as any[]).some((j) => j.id === r.body.jobId && j.status === "pending");
  }, 5000, "job pending");
  await api(`/api/bots/${workerId}`, { method: "PATCH", body: JSON.stringify({ status: "active" }) });
  const done = await waitJobDone(r.body.jobId, 60_000);
  record("queue pause/resume", held && done === "done", `held pending=${held} final=${done}`);
}

// 13. voice no-key paths
{
  const tts = await api("/api/voice/tts", { method: "POST", body: JSON.stringify({ text: "테스트", provider: "elevenlabs" }) });
  const sttForm = new FormData();
  sttForm.append("file", new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" }), "a.webm");
  const stt = await fetch(`${BASE}/api/voice/stt`, { method: "POST", body: sttForm });
  const sttBody = await stt.json().catch(() => ({}));
  record("voice no-key: tts fallback + stt hint", tts.status === 400 && tts.body.fallback === "browser" && stt.status === 400 && /dictation|OPENAI/i.test(sttBody.error ?? sttBody.hint ?? ""), `tts=${tts.status}/${tts.body.fallback} stt=${stt.status}`);
}

// 14. credentials vault
{
  await api("/api/settings/credentials", { method: "PUT", body: JSON.stringify({ key: "ELEVENLABS_API_KEY", value: "sk-fixture-eleven" }) });
  const s = await api("/api/settings");
  const cred = (s.body.credentials as any[]).find((c) => c.key === "ELEVENLABS_API_KEY");
  const stored = await dbHasEncryptedCredentials();
  record("credential vault (encrypted at rest)", cred?.present === true && stored, `present=${cred?.present} rows encrypted=${stored}`);
}
async function dbHasEncryptedCredentials(): Promise<boolean> {
  const { DatabaseSync } = await import("node:sqlite");
  const d = new DatabaseSync(path.join(dataDir, "openbot.db"), { readOnly: true });
  const row = d.prepare("SELECT value_enc AS v FROM credentials WHERE value_enc LIKE 'v1:%' LIMIT 1").get() as { v: string } | undefined;
  d.close();
  return Boolean(row);
}

// 15. BYO model provider (fake OpenAI-compatible server)
let fixProviderBotConv = "";
{
  const p = await api("/api/providers", {
    method: "POST",
    body: JSON.stringify({ name: "fixture", kind: "openai-compatible", baseUrl: `http://127.0.0.1:${fixture.port}/v1`, apiKey: "fixture-key", model: "fixture-1" }),
  });
  const b = await api("/api/bots", { method: "POST", body: JSON.stringify({ name: "FixBot", emoji: "🧪", providerId: p.body.id }) });
  fixProviderBotConv = b.body.conversationId;
  const s = await send(fixProviderBotConv, "실제 HTTP 프로바이더 경로 테스트");
  const msgs = await messagesOf(fixProviderBotConv);
  const reply = msgs.find((m) => m.role === "assistant");
  const sawKey = fixture.calls.chat.some((c) => c.auth === "Bearer fixture-key");
  record("BYO model credentials (real HTTP call)", s.status === "done" && reply?.content?.includes("fixture-reply") && sawKey, `reply="${reply?.content?.slice(0, 40)}" auth header sent=${sawKey}`);
}

// 16. OpenAPI tool source → dynamic tool through the loop
{
  const r = await api("/api/tool-sources", { method: "POST", body: JSON.stringify({ name: "petsrc", kind: "openapi", specUrl: `http://127.0.0.1:${fixture.port}/openapi.json` }) });
  const s = await send(fixProviderBotConv, "pets 목록 보여줘");
  const msgs = await messagesOf(fixProviderBotConv);
  const toolMsg = msgs.reverse().find((m) => m.role === "tool" && m.tool_name === "api.petsrc.list_pets");
  const result = toolMsg ? JSON.parse(toolMsg.tool_result) : null;
  record("OpenAPI tool source", r.body.status === "ok" && result?.ok === true && fixture.calls.pets >= 1, `source=${r.body.status}/${r.body.detail} pets api hits=${fixture.calls.pets} result=${JSON.stringify(result?.body ?? {}).slice(0, 80)}`);
}

// 17. remote MCP tool source → dynamic tool through the loop
{
  const r = await api("/api/tool-sources", { method: "POST", body: JSON.stringify({ name: "mcpsrc", kind: "mcp", url: `http://127.0.0.1:${fixture.port}/mcp` }) });
  const s = await send(fixProviderBotConv, "mcp echo 호출해줘");
  const msgs = await messagesOf(fixProviderBotConv);
  const toolMsg = msgs.reverse().find((m) => m.role === "tool" && m.tool_name === "mcp.mcpsrc.echo");
  const result = toolMsg ? JSON.parse(toolMsg.tool_result) : null;
  const initialized = fixture.calls.mcp.some((c) => c.method === "initialize");
  record("remote MCP tool source", r.body.status === "ok" && initialized && result?.text === "mcp-echo: hello-mcp", `source=${r.body.status} init=${initialized} result="${result?.text}"`);
}

// 17b. stdio MCP tool source (npx-style child process) → dynamic tool through the loop
{
  const r = await api("/api/tool-sources", {
    method: "POST",
    body: JSON.stringify({ name: "stdiosrc", kind: "mcp", transport: "stdio", command: process.execPath, args: [fixture.stdioScript] }),
  });
  const s = await send(fixProviderBotConv, "stdio echo 호출해줘");
  const msgs = await messagesOf(fixProviderBotConv);
  const toolMsg = msgs.reverse().find((m) => m.role === "tool" && m.tool_name === "mcp.stdiosrc.echo");
  const result = toolMsg ? JSON.parse(toolMsg.tool_result) : null;
  record("stdio MCP tool source", r.body.status === "ok" && result?.text === "stdio-echo: hello-stdio", `source=${r.body.status}/${r.body.detail} result="${result?.text}"`);
}

// 17c. tool source catalog lists the presets (http keyless + stdio officials)
{
  const r = await api("/api/tool-catalog");
  const entries = r.body as { id: string; transport: string }[];
  const ids = entries.map((e) => e.id);
  const hasHttp = entries.some((e) => e.id === "context7" && e.transport === "http");
  const hasStdio = entries.some((e) => e.id === "mcp-filesystem" && e.transport === "stdio" && e.command === "npx");
  record("tool source catalog", r.status === 200 && hasHttp && hasStdio && entries.length >= 5, `entries=${ids.join(",")}`);
}

// 17d. policy presets: workshop mode lets terminal run without an approval
{
  const ps = await api("/api/tool-policies/presets");
  const apply = await api("/api/tool-policies/presets/workshop/apply", { method: "POST" });
  const after = await api("/api/tool-policies");
  const term = (after.body as any[]).find((r) => r.tool === "terminal.exec");
  const g = await api("/api/bots", { method: "POST", body: JSON.stringify({ name: "Flow", emoji: "⚡" }) });
  const s = await send(g.body.conversationId, "terminal 로 run 해줘");
  const msgs = await messagesOf(g.body.conversationId);
  const toolMsg = msgs.find((m) => m.role === "tool" && m.tool_name === "terminal.exec");
  const res = toolMsg ? JSON.parse(toolMsg.tool_result) : null;
  const restored = await api("/api/tool-policies/presets/safe/apply", { method: "POST" });
  record("policy preset (workshop skips approval)",
    ps.status === 200 && (ps.body.presets ?? []).length >= 3 && apply.body.ok === true && term?.mode === "allow" && s.status === "done" && res?.exitCode === 0 && restored.body.ok === true,
    `presets=${(ps.body.presets ?? []).length} terminal=${term?.mode} job=${s.status} exit=${res?.exitCode}`);
}

// 17e. web search tool (keyless DuckDuckGo, real internet)
{
  const s = await send(alphaConv, "검색해줘: model context protocol 이 뭐야");
  const msgs = await messagesOf(alphaConv);
  const toolMsg = [...msgs].reverse().find((m) => m.role === "tool" && m.tool_name === "search.web");
  const res = toolMsg ? JSON.parse(toolMsg.tool_result) : null;
  record("web search tool (keyless)",
    s.status === "done" && (res?.results?.length ?? 0) >= 1 && typeof res.results[0].url === "string",
    `results=${res?.results?.length ?? 0} first="${res?.results?.[0]?.title?.slice(0, 50) ?? ""}"`);
}

// 17f. image attachment → multimodal content reaches the provider
{
  const pngB64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const png = Uint8Array.from(atob(pngB64), (ch) => ch.charCodeAt(0));
  const form = new FormData();
  form.append("file", new File([png], "dot.png", { type: "image/png" }));
  const up = await fetch(`${BASE}/api/media/attachments`, { method: "POST", body: form });
  const upBody = (await up.json()) as { path?: string; error?: string };
  const sendRes = await api(`/api/conversations/${fixProviderBotConv}/messages`, {
    method: "POST",
    body: JSON.stringify({ content: "이 이미지가 뭐야?", attachments: [{ path: upBody.path, name: "dot.png", contentType: "image/png" }] }),
  });
  const st = await waitJobDone(sendRes.body.jobId, 60_000);
  const sawImage = fixture.calls.chat.some((c) => {
    const b = c.body as { messages?: { role: string; content: unknown }[] };
    const lastUser = [...(b.messages ?? [])].reverse().find((m) => m.role === "user");
    return Array.isArray(lastUser?.content) && (lastUser!.content as { type: string }[]).some((p) => p.type === "image_url");
  });
  record("image attachment → vision content",
    up.status === 201 && Boolean(upBody.path) && st === "done" && sawImage,
    `upload=${up.status} job=${st} provider saw image_url=${sawImage}`);
}

// 17g. task board: the assignee bot reports completion itself via task.update
{
  const t = await api("/api/tasks", { method: "POST", body: JSON.stringify({ title: "매트릭스 작업: 보고서 초안", detail: "두 문단으로", assigneeBotId: alphaId }) });
  const taskId = t.body.id as string;
  const run = await api(`/api/tasks/${taskId}/run`, { method: "POST" });
  const st = await waitJobDone(run.body.jobId, 60_000);
  const after = await api("/api/tasks");
  const row = (after.body as any[]).find((x) => x.id === taskId);
  record("task board (bot reports done)",
    t.status === 201 && run.status === 202 && st === "done" && row?.status === "done",
    `run=${run.status} job=${st} finalStatus=${row?.status} lastActivity="${row?.activity?.at(-1)?.text?.slice(0, 40) ?? ""}"`);
}

// 17h. global search across messages + memories
{
  const r = await api(`/api/search?q=${encodeURIComponent("커피")}`);
  record("global search",
    r.status === 200 && (r.body.messages?.length ?? 0) >= 1 && (r.body.memories?.length ?? 0) >= 1,
    `messages=${r.body.messages?.length} memories=${r.body.memories?.length} tasks=${r.body.tasks?.length}`);
}

// 17i. backup via VACUUM INTO
{
  const r = await api("/api/backup", { method: "POST" });
  record("backup (VACUUM INTO)", r.status === 201 && r.body.ok === true && r.body.bytes > 1000, `file=${r.body.file} ${Math.round((r.body.bytes ?? 0) / 1024)}KB`);
}

// 17j. fleet stats + notification center (task completion from 17g)
{
  const s = await api("/api/stats");
  const n = await api("/api/notifications");
  const notifs = n.body as any[];
  record("stats + notification center",
    s.status === 200 && (s.body.bots?.length ?? 0) >= 4 && s.body.totals?.messages > 0 && notifs.length >= 1 && notifs.some((x) => x.kind === "task"),
    `bots=${s.body.bots?.length} msgs=${s.body.totals?.messages} tokens=${s.body.totals?.tokensIn + s.body.totals?.tokensOut} notifs=${notifs.length}`);
}

// 17k. command guard blocks categorically dangerous commands before approval
{
  const s = await send(fixProviderBotConv, "guard test");
  const msgs = await messagesOf(fixProviderBotConv);
  const toolMsg = msgs.reverse().find((m) => m.role === "tool" && m.tool_name === "terminal.exec");
  const result = toolMsg ? JSON.parse(toolMsg.tool_result) : null;
  const auditRows = await api("/api/audit?limit=30");
  const guardRow = (auditRows.body as any[]).find((a) => a.decision === "deny" && /command guard/.test(a.detail ?? ""));
  record("command guard (pre-approval block)",
    s.status === "done" && String(result?.error ?? "").includes("command guard") && Boolean(guardRow),
    `toolResult="${String(result?.error).slice(0, 60)}" auditDeny=${Boolean(guardRow)}`);
}

// 17l. checkpoints: auto snapshot + restore roundtrip
{
  const g = await api("/api/bots", { method: "POST", body: JSON.stringify({ name: "Snap", emoji: "📸" }) });
  const conv = g.body.conversationId as string;
  await send(conv, "파일 저장해줘"); // mock → fs.write → auto checkpoint
  const cps = await api("/api/checkpoints");
  const before = cps.body as any[];
  const snapCp = before.find((cp) => String(cp.label ?? "").includes("Snap"));
  const restoreRes = snapCp ? await api(`/api/checkpoints/${snapCp.id}/restore`, { method: "POST" }) : { status: 0, body: { ok: false } };
  record("checkpoints (auto snapshot + restore)",
    Boolean(snapCp) && restoreRes.body.ok === true,
    `checkpoints=${before.length} snap=${snapCp?.label ?? "none"} restore=${restoreRes.status}`);
}

// 17m. markdown memory layer: memory.save → file; memory files searchable
{
  const s = await send(alphaConv, "이것 좀 remember 해줘: 마크다운 메모리 테스트");
  const files = await api("/api/files?scope=memory");
  const allEntries = [];
  for (const d of (files.body.entries ?? []) as any[]) {
    if (d.type === "dir") {
      const sub = await api(`/api/files?scope=memory&path=${encodeURIComponent(d.name)}`);
      for (const f of (sub.body.entries ?? []) as any[]) allEntries.push(`${d.name}/${f.name}`);
    }
  }
  const mdFile = allEntries.find((f) => f.endsWith(".md"));
  let content = "";
  if (mdFile) {
    const r = await api(`/api/files/content?scope=memory&path=${encodeURIComponent(mdFile)}`);
    content = r.body.content ?? "";
  }
  const search = await api(`/api/search?q=${encodeURIComponent("마크다운 메모리")}`);
  const hitPath = search.body.memoryFiles?.[0]?.path as string | undefined;
  if (hitPath) {
    const r = await api(`/api/files/content?scope=memory&path=${encodeURIComponent(hitPath)}`);
    content = r.body.content ?? "";
  }
  record("markdown memory layer",
    s.status === "done" && Boolean(mdFile) && content.includes("마크다운 메모리") && (search.body.memoryFiles?.length ?? 0) >= 1,
    `files=${allEntries.length} md=${mdFile ?? "none"} hit=${hitPath ?? "none"} searchHits=${search.body.memoryFiles?.length ?? 0}`);
}

// 17n. files API roundtrip + path escape denial
{
  const put = await api("/api/files/content", { method: "PUT", body: JSON.stringify({ scope: "workspace", path: "files-ui-test.txt", content: "hello-files-ui" }) });
  const get = await api(`/api/files/content?scope=workspace&path=${encodeURIComponent("files-ui-test.txt")}`);
  const esc = await api(`/api/files/content?scope=workspace&path=${encodeURIComponent("../../openbot.db")}`);
  record("files API (roundtrip + escape guard)",
    put.status === 200 && (get.body.content ?? "") === "hello-files-ui" && esc.status === 400,
    `put=${put.status} roundtrip=${(get.body.content ?? "") === "hello-files-ui"} escape=${esc.status}`);
}

// 17o. telegram gateway: message in → bot reply out + remote approval buttons
{
  const cred = await api("/api/settings/credentials", { method: "PUT", body: JSON.stringify({ key: "TELEGRAM_BOT_TOKEN", value: "test-token" }) });
  fixture.tgQueue.push({ update_id: 9001, message: { chat: { id: 4242 }, from: { first_name: "QA" }, text: "/start" } });
  const bound = await waitFor(async () => fixture.tgSent.some((m) => String(m.text ?? "").includes("연결됨")), 15_000, "tg bind");
  fixture.tgQueue.push({ update_id: 9002, message: { chat: { id: 4242 }, text: "terminal 로 run 해줘" } });
  const approvalPushed = await waitFor(async () => fixture.tgSent.some((m) => String(m.text ?? "").includes("승인 요청")), 40_000, "tg approval push");
  const replyPushed = await waitFor(async () => fixture.tgSent.some((m) => String(m.text ?? "").includes("[mock]")), 60_000, "tg reply push");
  record("telegram gateway (in/out + approval buttons)",
    cred.status === 200 && bound && approvalPushed && replyPushed,
    `bind=${bound} approvalPush=${approvalPushed} reply=${replyPushed} sent=${fixture.tgSent.length}`);
}

// 17p. native desktop computer-use (optional agent-desktop, observe-only here)
{
  const s = await send(alphaConv, "desktop apps 보여줘");
  const msgs = await messagesOf(alphaConv);
  const toolMsg = msgs.reverse().find((m) => m.role === "tool" && m.tool_name === "desktop.list_apps");
  const result = toolMsg ? JSON.parse(toolMsg.tool_result) : null;
  const installed = Array.isArray(result?.apps);
  const s2 = await send(alphaConv, "desktop snapshot finder 해줘");
  const msgs2 = await messagesOf(alphaConv);
  const snapMsg = msgs2.reverse().find((m) => m.role === "tool" && m.tool_name === "desktop.snapshot");
  const snap = snapMsg ? JSON.parse(snapMsg.tool_result) : null;
  record("native desktop tools (agent-desktop)",
    Boolean(toolMsg) && (installed || String(result?.error ?? "").includes("agent-desktop")) && Boolean(snapMsg) && (Boolean(snap?.snapshotId) || String(snap?.error ?? "").includes("agent-desktop")),
    `apps=${installed ? result.apps.length + "개" : "미설치"} snapshot=${snap?.snapshotId ? `refs=${snap.refCount}` : "미설치/에러"}`);
}

// 18. composio without key → clear error
{
  const r = await api("/api/tool-sources", { method: "POST", body: JSON.stringify({ name: "comp", kind: "composio" }) });
  record("composio unconfigured error", r.body.status === "error" && /API key/i.test(r.body.detail), `detail="${r.body.detail}"`);
}

// 19. audit trail incl. policy deny (SSRF guard)
{
  const s = await send(fixProviderBotConv, "ssrf 차단 테스트");
  const msgs = await messagesOf(fixProviderBotConv);
  const toolMsg = msgs.reverse().find((m) => m.role === "tool" && m.tool_name === "browser.fetch");
  const result = toolMsg ? JSON.parse(toolMsg.tool_result) : null;
  const audit = await api("/api/audit?limit=200");
  const denyRow = (audit.body as any[]).find((a) => a.decision === "deny" && a.tool === "browser.fetch");
  const allowRow = (audit.body as any[]).find((a) => a.decision === "allow" && a.detail === "executed");
  record("audit trail + SSRF policy deny", Boolean(denyRow) && Boolean(allowRow) && result?.error?.includes("private"), `deny="${denyRow?.detail?.slice(0, 60)}" allow rows=${(audit.body as any[]).filter((a) => a.decision === "allow").length}`);
}

// 20. skills library seeded
{
  const r = await api("/api/skills");
  record("skills library", (r.body as any[]).some((s) => s.name === "web-research"), `skills=${(r.body as any[]).map((s: any) => s.name).join(",")}`);
}

// 21. desktop screenshot (honest capture — may be permission-blocked)
{
  const s = await send(alphaConv, "화면 스크린샷 찍어줘");
  const msgs = await messagesOf(alphaConv);
  const toolMsg = msgs.reverse().find((m) => m.role === "tool" && m.tool_name === "desktop.screenshot");
  const result = toolMsg ? JSON.parse(toolMsg.tool_result) : null;
  const ok = Boolean(result?.mediaPath);
  record("desktop screenshot (macOS)", Boolean(toolMsg) && (ok || /permission|screencapture/i.test(result?.error ?? "")), ok ? `media=${result.mediaPath} bytes=${result.bytes}` : `error="${result?.error?.slice(0, 80)}"`);
}

// 22. persistence across restart
{
  const before = await messagesOf(alphaConv);
  await stopServer();
  await startServer();
  const after = await messagesOf(alphaConv);
  const boot = await api("/api/bootstrap");
  record("persistence across restart", after.length === before.length && (boot.body.bots as any[]).length >= 4, `messages before=${before.length} after=${after.length} bots=${(boot.body.bots as any[]).length}`);
}

// 23. routine fires on schedule (created at 11.5, checked now)
{
  const fired = await waitFor(async () => {
    const w = await api("/api/bootstrap");
    const conv = (w.body.conversations as any[]).find((c: any) => c.kind === "dm" && c.bot_id === workerId);
    if (!conv) return false;
    const msgs = await messagesOf(conv.id);
    return msgs.some((m) => m.role === "user" && m.content.includes("[routine: 정시 인사]"));
  }, 90_000, "routine fire");
  const w2 = await api("/api/bootstrap");
  const conv = (w2.body.conversations as any[]).find((c: any) => c.kind === "dm" && c.bot_id === workerId);
  const msgs = conv ? await messagesOf(conv.id) : [];
  const routineReply = msgs.some((m) => m.role === "assistant");
  record("routine auto-fires (cron)", fired && routineReply, `routine msg seen=${fired} bot replied=${routineReply}`);
}

// 24. context compaction
{
  const big = "커피 좋아함 ".repeat(4200); // ~29k chars > 24k threshold
  await send(fixProviderBotConv, big);
  const s = await send(fixProviderBotConv, "이제 압축 테스트 두번째 메시지");
  const msgs = await messagesOf(fixProviderBotConv);
  const hasSummary = msgs.some((m) => m.role === "system");
  record("context compaction", s.status === "done" && hasSummary, `system summary row=${hasSummary} messages=${msgs.length}`);
}

// 25. browser.open graceful unavailability (playwright optional)
{
  const s = await send(fixProviderBotConv, "openpage 테스트");
  const msgs = await messagesOf(fixProviderBotConv);
  const toolMsg = msgs.reverse().find((m) => m.role === "tool" && m.tool_name === "browser.open");
  const result = toolMsg ? JSON.parse(toolMsg.tool_result) : null;
  record(
    "interactive browser tools (optional playwright)",
    Boolean(toolMsg) && (result?.screenshot ? result?.title?.includes("Example Domain") : result?.error?.includes("playwright")),
    result?.screenshot ? `screenshot=${result.screenshot} title="${result?.title}"` : `error="${result?.error?.slice(0, 90)}"`
  );
}

// 26. bot lifecycle: rename + delete cascade
{
  const b = await api("/api/bots", { method: "POST", body: JSON.stringify({ name: "TempBot", emoji: "🗑" }) });
  await send(b.body.conversationId, "임시 메시지");
  const patch = await api(`/api/bots/${b.body.id}`, { method: "PATCH", body: JSON.stringify({ name: "TempBot2", persona: "수정됨" }) });
  const renamed = (await api("/api/bootstrap")).body.bots.find((x: any) => x.id === b.body.id);
  const del = await api(`/api/bots/${b.body.id}`, { method: "DELETE" });
  const after = (await api("/api/bootstrap")).body.bots.find((x: any) => x.id === b.body.id);
  record("bot lifecycle (rename + delete cascade)", patch.status === 200 && renamed?.name === "TempBot2" && del.status === 200 && !after, `renamed=${renamed?.name} deleted=${!after}`);
}

// ---------------------------------------------------------------- teardown + report

async function teardown(code: number): Promise<never> {
  await stopServer();
  fixture.server.close();
  try {
    await fsp.rm(dataDir, { recursive: true, force: true });
  } catch {
    /* temp dir cleanup best-effort */
  }
  process.exit(code);
}

await stopServer();
fixture.server.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
for (const f of failed) console.log(`FAILED: ${f.name} — ${f.evidence}`);
await teardown(failed.length > 0 ? 1 : 0);
