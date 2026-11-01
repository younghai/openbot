import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { db, uid, now } from "../db.js";
import { MEDIA_DIR, SKILLS_DIR, MEMORY_DIR } from "../config.js";
import { runOnComputer, workspaceFor, ensureWorkspace } from "../computers/index.js";
import {
  registerTool, safeWorkspacePath, assertPublicHttpUrl, ToolDenial, retryHint, type ToolContext,
} from "./gateway.js";

const execFileP = promisify(execFile);

// ---------------------------------------------------------------- terminal + files (computer-scoped)


/**
 * Static command guard — the first line of defense BEFORE any approval:
 * categorically dangerous commands are refused even under an allow policy.
 * (QwenPaw Tool Guard pattern; runs inside the tool so denials hit the audit trail.)
 */
const COMMAND_GUARD: { re: RegExp; why: string }[] = [
  { re: /\bsudo\b/i, why: "sudo 권한 상승" },
  { re: /\brm\b[^|;&]*\s-\w*[rf]\w*\s+(\/|~)/, why: "루트/홈 재귀 삭제 (rm -rf / 또는 ~)" },
  { re: /\brm\s+\/\s/, why: "루트 삭제" },
  { re: /\bmkfs(\.|\b)/, why: "파일시스템 포맷" },
  { re: /\bdd\b[^|;&]*of=\/dev\//, why: "블록 장치 직접 쓰기 (dd of=/dev)" },
  { re: /(curl|wget)[^|;&]*\|\s*(ba)?sh(\s|$)/, why: "다운로드 즉시 셸 실행 (curl|sh)" },
  { re: /\bchmod\s+-R\s+777\s+\//, why: "루트 전체 권한 개방" },
  { re: /:\(\)\s*\{\s*:\|:&\s*\};:/ , why: "포크 폭탄" },
  { re: /\b(shutdown|reboot|halt)\b/, why: "시스템 종료/재부팅" },
  { re: />\s*\/dev\/sd[a-z]/, why: "블록 장치 덮어쓰기" },
];

function guardCommand(command: string): void {
  for (const g of COMMAND_GUARD) {
    if (g.re.test(command)) throw new ToolDenial(`command guard 차단: ${g.why}`);
  }
}

registerTool({
  name: "terminal.exec",
  description: "Run a shell command on the bot's computer inside its workspace directory. Returns stdout/stderr and exit code.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "shell command to execute" },
      timeoutMs: { type: "number", description: "timeout in milliseconds (max 120000, default 60000)" },
    },
    required: ["command"],
  },
  async execute(ctx, args) {
    const command = String(args.command ?? "");
    if (!command.trim()) throw new Error("command must not be empty");
    if (command.length > 8000) throw new Error("command too long");
    guardCommand(command);
    const timeout = Math.min(Number(args.timeoutMs ?? 60_000) || 60_000, 120_000);
    const result = await runOnComputer(ctx.computer, ctx.bot.id, command, timeout);
    const out = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    return {
      exitCode: result.exitCode,
      stdout: result.stdout.slice(0, 20_000),
      stderr: result.stderr.slice(0, 20_000),
      timedOut: result.timedOut ?? false,
      ...(result.timedOut ? { hint: retryHint("TIMEOUT", "unsafe", "부분 실행 가능 — 상태 확인 후 재시도") } : {}),
      preview: out.slice(0, 2000) || "(no output)",
    };
  },
});

registerTool({
  name: "fs.list",
  description: "List files in a directory on the bot's computer (relative to its workspace).",
  parameters: {
    type: "object",
    properties: { path: { type: "string", description: "relative directory path, default '.'" } },
  },
  async execute(ctx, args) {
    const root = ensureWorkspace(workspaceFor(ctx.computer, ctx.bot.id));
    const dir = safeWorkspacePath(root, String(args.path ?? "."));
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    return {
      path: path.relative(root, dir) || ".",
      entries: entries.slice(0, 500).map((e) => ({ name: e.name, type: e.isDirectory() ? "dir" : "file" })),
    };
  },
});

registerTool({
  name: "fs.read",
  description: "Read a text file from the bot's computer workspace.",
  parameters: {
    type: "object",
    properties: { path: { type: "string", description: "relative file path" } },
    required: ["path"],
  },
  async execute(ctx, args) {
    const root = ensureWorkspace(workspaceFor(ctx.computer, ctx.bot.id));
    const file = safeWorkspacePath(root, String(args.path ?? ""));
    const stat = await fsp.stat(file).catch(() => null);
    if (!stat?.isFile()) throw new Error(`file not found: ${args.path}`);
    if (stat.size > 2_000_000) throw new Error(`file too large (${stat.size} bytes)`);
    const content = await fsp.readFile(file, "utf8");
    return { path: String(args.path), bytes: stat.size, content: content.slice(0, 100_000) };
  },
});

registerTool({
  name: "fs.write",
  description: "Write (or overwrite) a text file in the bot's computer workspace.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "relative file path" },
      content: { type: "string", description: "file contents" },
    },
    required: ["path", "content"],
  },
  async execute(ctx, args) {
    const root = ensureWorkspace(workspaceFor(ctx.computer, ctx.bot.id));
    const file = safeWorkspacePath(root, String(args.path ?? ""));
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const content = String(args.content ?? "");
    if (content.length > 2_000_000) throw new Error("content too large");
    await fsp.writeFile(file, content, "utf8");
    return { path: String(args.path), bytes: Buffer.byteLength(content) };
  },
});

// ---------------------------------------------------------------- browser

registerTool({
  name: "browser.fetch",
  description: "Fetch a web page and return its readable text (scripts/styles stripped). Use for reading web content. http(s) only; private network addresses are blocked.",
  parameters: {
    type: "object",
    properties: { url: { type: "string", description: "full http(s) URL" } },
    required: ["url"],
  },
  async execute(_ctx, args) {
    const url = assertPublicHttpUrl(String(args.url ?? ""));
    const res = await fetch(url, {
      headers: { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 OpenBot/0.1", accept: "text/html,application/json,text/plain,*/*" },
      redirect: "follow",
      signal: AbortSignal.timeout(20_000),
    });
    const contentType = res.headers.get("content-type") ?? "";
    const raw = (await res.text()).slice(0, 2_000_000);
    if (contentType.includes("json")) {
      return { url: url.href, status: res.status, contentType, text: raw.slice(0, 12_000) };
    }
    const text = htmlToText(raw);
    const title = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? "";
    return { url: url.href, status: res.status, title, text: text.slice(0, 12_000) };
  },
});

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---------------------------------------------------------------- graphical desktop (macOS)

registerTool({
  name: "desktop.screenshot",
  description: "Capture a screenshot of the computer's graphical desktop (macOS). Returns a media path viewable in chat.",
  parameters: { type: "object", properties: {} },
  async execute(_ctx, _args) {
    if (process.platform !== "darwin") {
      throw new Error(`desktop.screenshot is implemented for macOS; this computer is ${process.platform}`);
    }
    fs.mkdirSync(MEDIA_DIR, { recursive: true });
    const rel = `screenshot-${Date.now()}.png`;
    const file = path.join(MEDIA_DIR, rel);
    try {
      await execFileP("screencapture", ["-x", "-t", "png", file], { timeout: 15_000 });
    } catch (err) {
      throw new Error(`screencapture failed (Screen Recording permission may be missing): ${err instanceof Error ? err.message : String(err)}`);
    }
    const stat = await fsp.stat(file);
    return { mediaPath: `/api/media/${rel}`, bytes: stat.size };
  },
});

// ---------------------------------------------------------------- memory

registerTool({
  name: "memory.save",
  description: "Persist a long-term memory about the user or your work. Stored per-bot and injected into future conversations.",
  parameters: {
    type: "object",
    properties: { content: { type: "string", description: "the fact or preference to remember" } },
    required: ["content"],
  },
  async execute(ctx, args) {
    try {
      const slug = String(args.content ?? "memory").toLowerCase().replace(/[^가-힣a-z0-9]+/g, "-").slice(0, 24).replace(/^-|-$/g, "") || "note";
      const dir = path.join(MEMORY_DIR, slugDir(ctx.bot.name));
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${new Date().toISOString().slice(0, 10)}-${uid().slice(0, 4)}.md`);
      fs.writeFileSync(file, `# 기억 — ${new Date().toISOString().slice(0, 16).replace("T", " ")}\n\n${String(args.content ?? "")}\n\n- 봇: ${ctx.bot.name}\n`);
    } catch { /* file write is best-effort; db row is the source of truth */ }
    const content = String(args.content ?? "").trim();
    if (!content) throw new Error("memory content must not be empty");
    db.prepare("INSERT INTO memories (id, bot_id, content, created_at) VALUES (?,?,?,?)").run(uid(), ctx.bot.id, content.slice(0, 4000), now());
    return { saved: true };
  },
});

registerTool({
  name: "memory.search",
  description: "Search this bot's long-term memories by keyword.",
  parameters: {
    type: "object",
    properties: { query: { type: "string", description: "search keyword" } },
    required: ["query"],
  },
  async execute(ctx, args) {
    const q = `%${String(args.query ?? "").replace(/[%_]/g, "")}%`;
    const rows = db
      .prepare("SELECT content, created_at FROM memories WHERE bot_id=? AND content LIKE ? ORDER BY created_at DESC LIMIT 10")
      .all(ctx.bot.id, q) as { content: string; created_at: number }[];
    return { matches: rows.length, memories: rows };
  },
});

// ---------------------------------------------------------------- skills (SKILL.md library, openbot-compatible)

registerTool({
  name: "skills.list",
  description: "List installed skills (SKILL.md folders) the bot can read for instructions.",
  parameters: { type: "object", properties: {} },
  async execute() {
    const skills = listSkills();
    return { count: skills.length, skills };
  },
});

registerTool({
  name: "skills.read",
  description: "Read a skill's SKILL.md instructions by name.",
  parameters: {
    type: "object",
    properties: { name: { type: "string", description: "skill folder name" } },
    required: ["name"],
  },
  async execute(_ctx, args) {
    const name = String(args.name ?? "").replace(/[^a-zA-Z0-9._-]/g, "");
    const file = path.join(SKILLS_DIR, name, "SKILL.md");
    if (!fs.existsSync(file)) throw new Error(`skill '${name}' not found`);
    const content = await fsp.readFile(file, "utf8");
    return { name, content: content.slice(0, 30_000) };
  },
});

export function listSkills(): { name: string; description: string }[] {
  fs.mkdirSync(SKILLS_DIR, { recursive: true });
  const out: { name: string; description: string }[] = [];
  for (const entry of fs.readdirSync(SKILLS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(SKILLS_DIR, entry.name, "SKILL.md");
    if (!fs.existsSync(file)) continue;
    const raw = fs.readFileSync(file, "utf8");
    const desc = raw.match(/^---[\s\S]*?description:\s*(.+)$/m)?.[1]?.trim() ?? "";
    out.push({ name: entry.name, description: desc });
  }
  return out;
}

// ---------------------------------------------------------------- delegation (peer bots + subagents)

export type DelegationRunner = (
  ctx: ToolContext,
  args: Record<string, unknown>,
  kind: "bot" | "subagent"
) => Promise<string>;

let delegationRunner: DelegationRunner | null = null;

export function setDelegationRunner(runner: DelegationRunner): void {
  delegationRunner = runner;
}

registerTool({
  name: "bot.delegate",
  description: "Delegate a task to a peer bot by name. The peer runs to completion in its own conversation and its final answer is returned.",
  parameters: {
    type: "object",
    properties: {
      bot: { type: "string", description: "peer bot name (optional if the task names it)" },
      task: { type: "string", description: "task description for the peer" },
    },
    required: ["task"],
  },
  internal: true,
  async execute(ctx, args) {
    if (!delegationRunner) throw new Error("delegation runner not wired");
    return { result: await delegationRunner(ctx, args, "bot") };
  },
});

registerTool({
  name: "subagent.run",
  description: "Spawn a short-lived subagent with a fresh context to complete a one-off task, returning its final answer.",
  parameters: {
    type: "object",
    properties: {
      task: { type: "string", description: "self-contained task for the subagent" },
      persona: { type: "string", description: "optional persona/system prompt override" },
    },
    required: ["task"],
  },
  internal: true,
  async execute(ctx, args) {
    if (!delegationRunner) throw new Error("delegation runner not wired");
    return { result: await delegationRunner(ctx, args, "subagent") };
  },
});

// ---------------------------------------------------------------- web search (keyless)

function decodeEntities(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCharCode(Number(d)))
    .replace(/\s+/g, " ")
    .trim();
}


/**
 * DuckDuckGo html endpoint. Node's fetch fingerprint gets an anomaly page from
 * DDG (measured), so an empty first pass falls back to the system curl binary.
 */
async function ddgHtml(query: string): Promise<string> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const headers = {
    "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    "accept-language": "ko,en;q=0.8",
  };
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
    if (res.ok) {
      const text = await res.text();
      if (text.includes("result__a")) return text;
    }
  } catch {
    // fall through to curl
  }
  try {
    const { stdout } = await execFileP("curl", ["-s", "--max-time", "15", "-A", headers["user-agent"], "-H", `accept-language: ${headers["accept-language"]}`, url], { timeout: 20_000, maxBuffer: 5 * 1024 * 1024 });
    if (stdout.includes("result__a")) return stdout;
    return stdout; // let the parser decide; empty results note explains
  } catch (err) {
    throw new Error(`search failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

registerTool({
  name: "search.web",
  description: "Search the web (DuckDuckGo, no API key). Use for current information, docs, or anything you don't know. Returns top results with title/url/snippet.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "search query" },
    },
    required: ["query"],
  },
  async execute(_ctx, args) {
    const query = String(args.query ?? "").trim();
    if (!query) throw new Error("query must not be empty");
    const html = await ddgHtml(query);
    const snippets: string[] = [];
    const snipRe = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    let sm: RegExpExecArray | null;
    while ((sm = snipRe.exec(html)) && snippets.length < 8) snippets.push(decodeEntities(sm[1]));
    const linkRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    const results: { title: string; url: string; snippet: string }[] = [];
    let m: RegExpExecArray | null;
    let i = 0;
    while ((m = linkRe.exec(html)) && results.length < 6) {
      let url = m[1].replace(/&amp;/g, "&");
      const uddg = /[?&]uddg=([^&]+)/.exec(url);
      if (uddg) url = decodeURIComponent(uddg[1]);
      const title = decodeEntities(m[2]);
      if (title && url.startsWith("http")) results.push({ title: title.slice(0, 160), url, snippet: (snippets[i] ?? "").slice(0, 240) });
      i++;
    }
    if (results.length === 0) return { query, results: [], note: "검색 결과가 없거나 차단되었을 수 있습니다. browser.fetch로 직접 URL을 열어보세요." };
    // rank: one result per domain (keep the first), so six results cover six sources
    const seenDomains = new Set<string>();
    const deduped = results.filter((r) => {
      try {
        const host = new URL(r.url).hostname.replace(/^www\./, "");
        if (seenDomains.has(host)) return false;
        seenDomains.add(host);
        return true;
      } catch {
        return false;
      }
    });
    return { query, results: deduped };
  },
});

// ---------------------------------------------------------------- task board reporting

registerTool({
  name: "task.update",
  description: "Update one of your assigned tasks: change status (backlog/doing/review/done) and leave a progress or completion note. Task ids are listed in 'Your assigned tasks' in your context.",
  parameters: {
    type: "object",
    properties: {
      taskId: { type: "string", description: "task id or its 8-char prefix from [TASK xxxx]" },
      status: { type: "string", enum: ["backlog", "doing", "review", "done"], description: "new status" },
      note: { type: "string", description: "progress note or completion summary" },
    },
    required: ["taskId"],
  },
  async execute(ctx, args) {
    const { broadcastTask, taskWithBot } = await import("../routes/tasks.js");
    const prefix = String(args.taskId ?? "").trim();
    if (!prefix) throw new Error("taskId required");
    const row = db.prepare("SELECT * FROM tasks WHERE (id=? OR substr(id,1,8)=?) AND (assignee_bot_id=? OR assignee_bot_id IS NULL)").get(prefix, prefix, ctx.bot.id) as Record<string, unknown> | undefined;
    if (!row) throw new Error(`no assignable task matching '${prefix}' for this bot`);
    const status = String(args.status ?? "");
    if (status) {
      if (!["backlog", "doing", "review", "done"].includes(status)) throw new Error(`invalid status '${status}'`);
      db.prepare("UPDATE tasks SET status=?, completed_at=?, updated_at=? WHERE id=?").run(status, status === "done" ? Date.now() : null, Date.now(), row.id as string);
    }
    const note = String(args.note ?? "");
    if (note) {
      const list = JSON.parse(String(row.activity ?? "[]")) as unknown[];
      list.push({ at: Date.now(), by: ctx.bot.name, text: note.slice(0, 500) });
      db.prepare("UPDATE tasks SET activity=?, updated_at=? WHERE id=?").run(JSON.stringify(list).slice(0, 20_000), Date.now(), row.id as string);
    }
    if (status === "done" || status === "review") {
      const { notify } = await import("../notifications.js");
      notify("task", `봇 ${ctx.bot.name}: '${String(row.title).slice(0, 60)}' ${status === "done" ? "완료" : "검토 요청"}`, note.slice(0, 200));
    }
    broadcastTask(row.id as string);
    const updated = db.prepare("SELECT * FROM tasks WHERE id=?").get(String(row.id)) as Record<string, unknown>;
    return { ok: true, task: taskWithBot(updated) };
  },
});


function slugDir(name: string): string {
  return name.toLowerCase().replace(/[^가-힣a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "default";
}

/** ReMe-style memory layer: memories are plain Markdown files the bot (and the Files view) can read and edit. */
registerTool({
  name: "memory.write",
  description: "Create or update a Markdown memory file in your memory directory. Use for structured, durable knowledge (preferences, project facts, how-tos) rather than one-line facts.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "file name, e.g. 'project-openbot.md' (kept under your memory directory)" },
      content: { type: "string", description: "full Markdown content" },
    },
    required: ["path", "content"],
  },
  async execute(ctx, args) {
    const rel = String(args.path ?? "").replace(/^[/\\]+/, "");
    if (!rel || rel.includes("..")) throw new ToolDenial("invalid memory path");
    const dir = path.join(MEMORY_DIR, slugDir(ctx.bot.name));
    const file = safeWorkspacePath(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, String(args.content ?? ""));
    return { ok: true, path: path.relative(MEMORY_DIR, file) };
  },
});

registerTool({
  name: "memory.read",
  description: "Read your Markdown memory files (list files with empty path).",
  parameters: {
    type: "object",
    properties: { path: { type: "string", description: "file name; omit to list files" } },
  },
  async execute(ctx, args) {
    const dir = path.join(MEMORY_DIR, slugDir(ctx.bot.name));
    const rel = String(args.path ?? "");
    if (!rel) {
      const list: string[] = [];
      const walk = (d: string, prefix: string): void => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          if (e.name.startsWith(".")) continue;
          if (e.isDirectory()) walk(path.join(d, e.name), `${prefix}${e.name}/`);
          else list.push(prefix + e.name);
        }
      };
      walk(dir, "");
      return { files: list.slice(0, 200) };
    }
    if (rel.includes("..")) throw new ToolDenial("invalid memory path");
    const file = safeWorkspacePath(dir, rel);
    return { path: rel, content: fs.readFileSync(file, "utf8").slice(0, 20_000) };
  },
});
