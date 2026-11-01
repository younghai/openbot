import path from "node:path";
import { db, uid, now, type BotRow, type ComputerRow } from "../db.js";
import { policyFor, requestApproval } from "../approvals.js";

export interface ToolContext {
  bot: BotRow;
  computer: ComputerRow;
  conversationId: string;
  /** delegation depth; 0 = human-triggered top level */
  depth: number;
  /** bot ids already in the delegation chain (cycle guard) */
  visited: string[];
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (ctx: ToolContext, args: Record<string, unknown>) => Promise<unknown>;
  /** internal tools are hidden from subagents at depth > 0 */
  internal?: boolean;
}

/**
 * P2 error contract: annotate tool failures with retry safety so the model
 * doesn't blindly retry side-effecting operations.
 */
export function retryHint(code: string, retry: "safe" | "unsafe" | "unknown", suggestion?: string): string {
  const label = retry === "safe" ? "재시도 안전" : retry === "unsafe" ? "재시도 위험(부작용 가능)" : "재시도 판단 필요";
  return `[${code} · ${label}${suggestion ? ` — ${suggestion}` : ""}]`;
}

export class ToolDenial extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "ToolDenial";
  }
}

const registry = new Map<string, ToolSpec>();

export function registerTool(spec: ToolSpec): void {
  registry.set(spec.name, spec);
}

export function toolSpecsFor(depth: number): ToolSpec[] {
  return [...registry.values()].filter((t) => depth === 0 || !t.internal);
}

export function audit(
  ctx: ToolContext | null,
  tool: string,
  args: Record<string, unknown>,
  decision: "allow" | "deny" | "error",
  detail: string
): void {
  db.prepare(
    "INSERT INTO audit_log (bot_id, conversation_id, tool, args, decision, detail, created_at) VALUES (?,?,?,?,?,?,?)"
  ).run(ctx?.bot.id ?? null, ctx?.conversationId ?? null, tool, JSON.stringify(args).slice(0, 2000), decision, detail.slice(0, 2000), now());
}

/** Resolve a relative/absolute path against the computer workspace, denying escapes. */
export function safeWorkspacePath(workspaceRoot: string, requested: string): string {
  const clean = requested.replace(/^~\//, "");
  const resolved = path.resolve(workspaceRoot, clean);
  const root = path.resolve(workspaceRoot);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new ToolDenial(`path '${requested}' escapes the computer workspace`);
  }
  return resolved;
}

const PRIVATE_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^0\.0\.0\.0$/,
  /^::1$/,
  /^\[::1\]$/,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
];

export function assertPublicHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ToolDenial(`invalid URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ToolDenial(`only http(s) URLs are allowed, got ${url.protocol}`);
  }
  if (PRIVATE_HOST_PATTERNS.some((re) => re.test(url.hostname))) {
    throw new ToolDenial(`target host '${url.hostname}' is a private/loopback address and is blocked`);
  }
  return url;
}

/**
 * The single entry point for every tool execution: approval gate, policy gate,
 * audit trail, execution. Mirrors CopilotKit OpenBot's "every action decided
 * before it happens and recorded after". Tools whose policy is 'ask' block on
 * a human decision (see approvals.ts) before anything runs.
 */
export async function executeTool(
  ctx: ToolContext,
  name: string,
  args: Record<string, unknown>
): Promise<{ ok: boolean; result: unknown }> {
  const spec = registry.get(name);
  if (!spec) {
    // dynamic tool sources (mcp.*, api.*, composio.*, pd.*, treg.*) go through the same gates
    const gate = await gateApproval(ctx, name, args);
    if (!gate.allowed) return { ok: false, result: { error: gate.reason } };
    const rowId = insertAudit(ctx, name, args, "allow", gate.approved ? "user approved; executing" : "dynamic tool source; executing");
    try {
      const { dispatchDynamicTool } = await import("./dynamic.js");
      const result = await dispatchDynamicTool(name, args);
      db.prepare("UPDATE audit_log SET detail='executed' WHERE id=?").run(rowId);
      return { ok: true, result };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      db.prepare("UPDATE audit_log SET decision='error', detail=? WHERE id=?").run(msg, rowId);
      return { ok: false, result: { error: msg } };
    }
  }
  if (spec.internal && ctx.depth > 0) {
    audit(ctx, name, args, "deny", `internal tool not available to subagents (depth ${ctx.depth})`);
    return { ok: false, result: { error: `tool '${name}' is not available at delegation depth ${ctx.depth}` } };
  }
  const gate = await gateApproval(ctx, name, args);
  if (!gate.allowed) return { ok: false, result: { error: gate.reason } };
  // checkpoint the workspace right before approved side-effect tools run
  if (name === "terminal.exec" || name === "fs.write") void snapshotBeforeTool(ctx);
  const rowId = insertAudit(ctx, name, args, "allow", gate.approved ? "user approved; executing" : "policy check passed; executing");
  try {
    const result = await spec.execute(ctx, args);
    db.prepare("UPDATE audit_log SET detail='executed' WHERE id=?").run(rowId);
    return { ok: true, result };
  } catch (err) {
    const isDenial = err instanceof ToolDenial;
    const msg = err instanceof Error ? err.message : String(err);
    db.prepare("UPDATE audit_log SET decision=?, detail=? WHERE id=?").run(isDenial ? "deny" : "error", msg, rowId);
    return { ok: false, result: { error: msg } };
  }
}


/** Best-effort workspace snapshot before a side-effect tool runs (see checkpoints.ts). */
async function snapshotBeforeTool(ctx: ToolContext): Promise<void> {
  try {
    const { workspaceFor, ensureWorkspace } = await import("../computers/index.js");
    const ws = ensureWorkspace(workspaceFor(ctx.computer, ctx.bot.id));
    const { snapshotSync } = await import("../checkpoints.js");
    snapshotSync(ws, `${ctx.computer.name}:${ctx.bot.name}`, `before ${ctx.conversationId ?? "run"}`);
  } catch {
    // snapshots must never break tool execution
  }
}

interface GateResult {
  allowed: boolean;
  approved: boolean;
  reason?: string;
}

async function gateApproval(ctx: ToolContext, name: string, args: Record<string, unknown>): Promise<GateResult> {
  if (policyFor(name) !== "ask") return { allowed: true, approved: false };
  const verdict = await requestApproval(ctx, name, args);
  if (verdict === "approved") return { allowed: true, approved: true };
  const reason =
    verdict === "denied" ? `tool '${name}' blocked: user denied approval`
    : verdict === "expired" ? `tool '${name}' blocked: approval timed out`
    : `tool '${name}' not approved`;
  audit(ctx, name, args, "deny", `approval ${verdict}`);
  return { allowed: false, approved: false, reason };
}

function insertAudit(
  ctx: ToolContext | null,
  tool: string,
  args: Record<string, unknown>,
  decision: "allow" | "deny" | "error",
  detail: string
): number {
  db.prepare(
    "INSERT INTO audit_log (bot_id, conversation_id, tool, args, decision, detail, created_at) VALUES (?,?,?,?,?,?,?)"
  ).run(ctx?.bot.id ?? null, ctx?.conversationId ?? null, tool, JSON.stringify(args).slice(0, 2000), decision, detail.slice(0, 2000), now());
  const row = db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number };
  return row.id;
}

export function newId(): string {
  return uid();
}
