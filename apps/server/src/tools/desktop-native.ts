import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { registerTool, ToolDenial } from "./gateway.js";

const execFileP = promisify(execFile);

/**
 * Native desktop computer-use over agent-desktop (vercel-labs, Apache-2.0):
 * the OS accessibility tree instead of pixels. Snapshot returns stable refs;
 * the bot acts on a ref and re-snapshots to verify (see the desktop-use skill).
 * Observe = allow, act = ask (approval queue) — "보는 건 자유, 만지는 건 승인".
 */

const BIN = process.env.AGENT_DESKTOP_BIN ?? "agent-desktop";
const INSTALL_HINT = "agent-desktop 미설치 — `npm install -g agent-desktop` 후 macOS 접근성 권한을 허용하세요 (안내: `agent-desktop permissions --guide`)";
const MAX_TREE_NODES = 250;
const MAX_JSON_CHARS = 9_000; // tool results are capped at 12k chars in the agent loop

interface AdEnvelope {
  ok: boolean;
  data?: Record<string, unknown>;
  error?: { code?: string; message?: string; disposition?: { retry?: string }; suggestion?: string };
}

async function ad(args: string[]): Promise<AdEnvelope> {
  let stdout: string;
  try {
    const res = await execFileP(BIN, args, { timeout: 90_000, maxBuffer: 16 * 1024 * 1024 });
    stdout = res.stdout;
  } catch (err) {
    const e = err as { stdout?: string; message?: string; code?: string };
    if (e.code === "ENOENT") throw new Error(INSTALL_HINT);
    let envelope: AdEnvelope | null = null;
    try { envelope = JSON.parse(String(e.stdout ?? "")) as AdEnvelope; } catch { /* non-JSON */ }
    if (envelope?.error) throw new Error(adErrorText(envelope.error));
    throw new Error(`agent-desktop 실패: ${String(e.message ?? err).slice(0, 300)}`);
  }
  try {
    const parsed = JSON.parse(stdout) as AdEnvelope;
    if (!parsed.ok && parsed.error) throw new Error(adErrorText(parsed.error));
    return parsed;
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("agent-desktop")) throw err;
    throw new Error(`agent-desktop 응답 파싱 실패: ${stdout.slice(0, 200)}`);
  }
}

function adErrorText(e: NonNullable<AdEnvelope["error"]>): string {
  const retry = e.disposition?.retry === "safe" ? "safe(안전)" : e.disposition?.retry === "unsafe" ? "unsafe(위험)" : "판단 필요";
  const parts = [`agent-desktop ${e.code ?? "ERROR"}`];
  if (e.message) parts.push(e.message.slice(0, 200));
  parts.push(`재시도: ${retry}`);
  if (e.suggestion) parts.push(`제안: ${String(e.suggestion).slice(0, 200)}`);
  if (e.code === "STALE_REF" || e.code === "AMBIGUOUS_TARGET") parts.push("새 스냅샷을 뜨고 그 스냅샷의 ref로 다시 시도하세요.");
  return parts.join(" — ");
}

function pruneTree(node: unknown, budget: { left: number }): unknown {
  if (budget.left <= 0 || node === null || typeof node !== "object") return null;
  budget.left -= 1;
  const n = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of ["role", "name", "ref_id", "available_actions", "states", "value"]) {
    if (n[key] !== undefined) out[key] = n[key];
  }
  if (Array.isArray(n.children)) {
    const kids: unknown[] = [];
    for (const child of n.children) {
      const kept = pruneTree(child, budget);
      if (kept !== null) kids.push(kept);
      if (budget.left <= 0) break;
    }
    if (kids.length > 0) out.children = kids;
    if (budget.left <= 0 && n.children.length > kids.length) out.truncated = true;
  }
  return Object.keys(out).length > 0 ? out : { role: String(n.role ?? "node") };
}

registerTool({
  name: "desktop.list_apps",
  description: "List desktop applications currently running (name, bundle id, pid). Observe-only. Use before desktop.snapshot to get exact app names.",
  parameters: { type: "object", properties: {} },
  async execute() {
    const env = await ad(["list-apps"]);
    const apps = (env.data?.apps as Record<string, unknown>[] | undefined) ?? [];
    return {
      apps: apps
        .filter((a) => a.presentation !== "background")
        .slice(0, 60)
        .map((a) => ({ name: a.name, bundleId: a.bundle_id ?? null, pid: a.pid ?? null })),
      note: "desktop.snapshot {app} 으로 UI 구조를 읽고 desktop.act 로 조작한다.",
    };
  },
});

registerTool({
  name: "desktop.snapshot",
  description: "Read a desktop app's UI structure through the OS accessibility tree (headless, observe-only). Returns stable refs (@snapshot:eN) with roles, names and available actions. Refs belong to THIS snapshot — act immediately or re-snapshot. Dense apps: skeleton first, then drill with root.",
  parameters: {
    type: "object",
    properties: {
      app: { type: "string", description: "application name from desktop.list_apps (e.g. Finder)" },
      windowId: { type: "string", description: "pick one window when several are open (from error details)" },
      root: { type: "string", description: "qualified ref to drill into one region instead of the whole tree" },
      skeleton: { type: "boolean", description: "containers only — for dense apps" },
      waitFor: { type: "string", description: "role:text selector to wait for (e.g. 'button:저장')" },
    },
    required: ["app"],
  },
  async execute(_ctx, args) {
    const cli = ["snapshot", "--app", String(args.app ?? ""), "-i", "--compact"];
    if (args.windowId) cli.push("--window-id", String(args.windowId));
    if (args.root) cli.push("--root", String(args.root));
    if (args.skeleton) cli.push("--skeleton");
    if (args.waitFor) cli.push("--wait-for", String(args.waitFor));
    const env = await ad(cli);
    const data = env.data ?? {};
    const budget = { left: MAX_TREE_NODES };
    const payload = {
      app: data.app,
      window: data.window,
      snapshotId: data.snapshot_id,
      refCount: data.ref_count,
      complete: data.complete,
      tree: pruneTree(data.tree, budget),
      truncated: budget.left <= 0,
    };
    let text = JSON.stringify(payload);
    if (text.length > MAX_JSON_CHARS) {
      payload.tree = { note: "tree too large — use root/skeleton to drill in", snapshotId: payload.snapshotId };
      text = JSON.stringify(payload);
    }
    return JSON.parse(text) as Record<string, unknown>;
  },
});

const REF_ACTIONS = new Set(["click", "double-click", "triple-click", "right-click", "clear", "focus", "select", "toggle", "check", "uncheck", "expand", "collapse", "scroll", "scroll-to", "hover"]);
const TEXT_ACTIONS = new Set(["type", "set-value"]);

registerTool({
  name: "desktop.act",
  description: "Act on a desktop app through a qualified ref from a recent desktop.snapshot (headless). After acting, re-snapshot to verify. STALE_REF/AMBIGUOUS_TARGET means the UI changed — take a new snapshot. press takes a key combo (return, cmd+c…); launch starts an app.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: [...REF_ACTIONS, ...TEXT_ACTIONS, "press", "launch"] },
      ref: { type: "string", description: "qualified ref like @<snapshot_id>:eN" },
      text: { type: "string", description: "text/value for type and set-value" },
      combo: { type: "string", description: "key combo for press, e.g. return, escape, cmd+c" },
      app: { type: "string", description: "app name for press (--app) and launch" },
      waitFor: { type: "string", description: "role:text selector to wait for after acting (verification)" },
    },
    required: ["action"],
  },
  async execute(_ctx, args) {
    const action = String(args.action ?? "");
    const cli: string[] = [action];
    if (REF_ACTIONS.has(action) || TEXT_ACTIONS.has(action)) {
      const ref = String(args.ref ?? "");
      if (!/^@[A-Za-z0-9_-]+:e\d+$/.test(ref)) {
        throw new ToolDenial(`ref must be a qualified ref from a snapshot (예: @s3tfo3ow7zdxkz:e8). bare e8은 거부된다 — desktop.snapshot으로 새 ref를 얻으세요`);
      }
      cli.push(ref);
      if (TEXT_ACTIONS.has(action)) {
        if (args.text === undefined) throw new ToolDenial(`${action} requires text`);
        cli.push(String(args.text));
      }
    } else if (action === "press") {
      if (!args.combo) throw new ToolDenial("press requires combo (예: return, cmd+c)");
      cli.push(String(args.combo));
      if (args.app) cli.push("--app", String(args.app));
    } else if (action === "launch") {
      if (!args.app) throw new ToolDenial("launch requires app");
      cli.push(String(args.app));
    }
    if (args.waitFor) cli.push("--wait-for", String(args.waitFor));
    const env = await ad(cli);
    const data = env.data ?? {};
    const summary: Record<string, unknown> = { ok: true, action };
    for (const key of ["performed", "snapshot_id", "window", "wait_for"]) {
      if (data[key] !== undefined) summary[key] = data[key];
    }
    if (data.tree) {
      const budget = { left: 100 };
      summary.tree = pruneTree(data.tree, budget);
    }
    return summary;
  },
});
