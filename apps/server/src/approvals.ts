import { db, uid, now } from "./db.js";
import { broadcast } from "./events.js";

/**
 * Tool approval queue: side-effecting tools wait for a human decision before
 * running. Verdicts arrive through REST (/api/approvals/:id/approve|deny),
 * everyone is notified over WS, and undecided requests expire — the safe
 * direction — after APPROVAL_TIMEOUT_MS or on server restart.
 */

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired";
export type ApprovalVerdict = "approved" | "denied" | "expired";

export interface ApprovalRow {
  id: string;
  bot_id: string | null;
  conversation_id: string | null;
  tool: string;
  args: string | null;
  status: ApprovalStatus;
  decided_at: number | null;
  detail: string | null;
  created_at: number;
}

const APPROVAL_TIMEOUT_MS = Number(process.env.OPENBOT_APPROVAL_TIMEOUT_MS ?? 10 * 60_000);

interface Waiter {
  resolve: (v: ApprovalVerdict) => void;
  timer: ReturnType<typeof setTimeout>;
}
const waiters = new Map<string, Waiter>();

export function policyFor(tool: string): "allow" | "ask" {
  const row = db.prepare("SELECT mode FROM tool_policies WHERE tool=?").get(tool) as { mode: string } | undefined;
  return row?.mode === "allow" ? "allow" : "ask";
}

export function listToolPolicies(): { tool: string; mode: string }[] {
  return db.prepare("SELECT tool, mode FROM tool_policies ORDER BY tool").all() as { tool: string; mode: string }[];
}

// ---------------------------------------------------------------- policy presets (data)

export interface PolicyPreset {
  id: string;
  name: string;
  description: string;
  changes: Record<string, "allow" | "ask">;
}

export const POLICY_PRESETS: PolicyPreset[] = [
  {
    id: "safe",
    name: "기본 (안전)",
    description: "부작용 도구(터미널·파일 쓰기·브라우저 조작·화면 캡처)는 매번 승인. 읽기 전용은 자동 허용.",
    changes: {
      "terminal.exec": "ask", "fs.write": "ask", "python.exec": "ask",
      "browser.open": "ask", "browser.click": "ask", "browser.type": "ask",
      "desktop.screenshot": "allow", "desktop.list_apps": "allow", "desktop.snapshot": "allow", "desktop.act": "ask", "browser.fetch": "allow", "search.web": "allow",
      "arxiv.search": "allow", "pubmed.search": "allow", "research.report": "ask", "ui.render": "allow",
      "knowledge.index": "allow", "knowledge.search": "allow", "knowledge.list": "allow",
      "email.send": "ask", "email.status": "allow",
      "phone.sms": "ask", "phone.call": "ask", "phone.status": "allow",
      "payment.send": "ask", "payment.status": "allow",
    },
  },
  {
    id: "workshop",
    name: "로컬 작업장",
    description: "워크스페이스 안 터미널·파일 쓰기 자동 허용(일상 자동화용). 브라우저 조작·화면 캡처는 승인 유지.",
    changes: {
      "terminal.exec": "allow", "fs.write": "allow", "python.exec": "allow",
      "browser.open": "ask", "browser.click": "ask", "browser.type": "ask",
      "desktop.screenshot": "allow", "desktop.list_apps": "allow", "desktop.snapshot": "allow", "desktop.act": "ask", "browser.fetch": "allow", "search.web": "allow",
      "arxiv.search": "allow", "pubmed.search": "allow", "research.report": "ask", "ui.render": "allow",
      "knowledge.index": "allow", "knowledge.search": "allow", "knowledge.list": "allow",
      "email.send": "ask", "email.status": "allow",
      "phone.sms": "ask", "phone.call": "ask", "phone.status": "allow",
      "payment.send": "ask", "payment.status": "allow",
    },
  },
  {
    id: "locked",
    name: "잠금 (최대 보수)",
    description: "웹 fetch·검색을 포함해 거의 모든 도구가 승인 필요. 외부 반출 우려가 있을 때.",
    changes: {
      "terminal.exec": "ask", "fs.write": "ask", "python.exec": "ask",
      "browser.open": "ask", "browser.click": "ask", "browser.type": "ask",
      "desktop.screenshot": "ask", "desktop.list_apps": "ask", "desktop.snapshot": "ask", "desktop.act": "ask", "browser.fetch": "ask", "search.web": "ask",
      "arxiv.search": "ask", "pubmed.search": "ask", "research.report": "ask", "ui.render": "allow",
      "knowledge.index": "ask", "knowledge.search": "ask", "knowledge.list": "ask",
      "email.send": "ask", "email.status": "ask",
      "phone.sms": "ask", "phone.call": "ask", "phone.status": "ask",
      "payment.send": "ask", "payment.status": "ask",
    },
  },
];

export function applyPolicyPreset(presetId: string): PolicyPreset {
  const preset = POLICY_PRESETS.find((p) => p.id === presetId);
  if (!preset) throw new Error(`unknown policy preset '${presetId}'`);
  const up = db.prepare("INSERT INTO tool_policies (tool, mode) VALUES (?,?) ON CONFLICT(tool) DO UPDATE SET mode=excluded.mode");
  for (const [tool, mode] of Object.entries(preset.changes)) up.run(tool, mode);
  return preset;
}

/** Which preset the current tool_policies rows match (derived, not stored). */
export function currentPolicyPreset(): string {
  const rows = db.prepare("SELECT tool, mode FROM tool_policies").all() as { tool: string; mode: string }[];
  const map = new Map(rows.map((r) => [r.tool, r.mode]));
  for (const preset of POLICY_PRESETS) {
    const matches = Object.entries(preset.changes).every(([tool, mode]) => map.get(tool) === mode);
    if (matches) return preset.id;
  }
  return "custom";
}

function getApproval(id: string): ApprovalRow | undefined {
  return db.prepare("SELECT * FROM approvals WHERE id=?").get(id) as unknown as ApprovalRow | undefined;
}

// ---------------------------------------------------------------- scoped allows (CopilotKit OpenBot 패턴)

/**
 * 승인 결정의 지속(CopilotKit OpenBot approvals.md 패턴):
 * - once: 이번만 (기존 동작)
 * - conversation: 같은 대화·같은 봇·같은 도구는 더 묻지 않음
 * - always: 같은 봇·같은 도구는 어디서든 더 묻지 않음 (사용자 규칙으로 저장)
 * 잠금 프리셋은 "가장 엄격한 규칙이 이긴다" 원칙으로 스코프 허용을 무시한다.
 */
export type AllowScope = "once" | "conversation" | "always";

export function scopedAllowActive(botId: string, conversationId: string | null, tool: string): string | null {
  if (currentPolicyPreset() === "locked") return null;
  const conv = conversationId ?? "";
  const row = db.prepare(
    "SELECT scope FROM approval_allows WHERE tool=? AND bot_id=? AND (scope='bot' OR (scope='conversation' AND conversation_id=?)) LIMIT 1"
  ).get(tool, botId, conv) as { scope: string } | undefined;
  return row?.scope ?? null;
}

export interface AllowRow {
  scope: string;
  conversation_id: string;
  bot_id: string;
  tool: string;
  created_at: number;
}

export function listApprovalAllows(): AllowRow[] {
  return db.prepare("SELECT * FROM approval_allows ORDER BY created_at DESC LIMIT 200").all() as unknown as AllowRow[];
}

export function removeApprovalAllow(scope: string, conversationId: string, botId: string, tool: string): void {
  db.prepare("DELETE FROM approval_allows WHERE scope=? AND conversation_id=? AND bot_id=? AND tool=?").run(scope, conversationId, botId, tool);
}

export function listApprovals(status?: string): ApprovalRow[] {
  if (status) {
    return db.prepare("SELECT * FROM approvals WHERE status=? ORDER BY created_at DESC LIMIT 200").all(status) as unknown as ApprovalRow[];
  }
  return db.prepare("SELECT * FROM approvals ORDER BY created_at DESC LIMIT 200").all() as unknown as ApprovalRow[];
}

export function decideApproval(id: string, decision: "approved" | "denied", allowScope: AllowScope = "once"): { ok: boolean; error?: string } {
  const row = getApproval(id);
  if (!row) return { ok: false, error: "approval not found" };
  if (row.status !== "pending") return { ok: false, error: `approval already ${row.status}` };
  db.prepare("UPDATE approvals SET status=?, decided_at=?, detail=? WHERE id=? AND status='pending'").run(decision, now(), allowScope !== "once" ? `allowed: ${allowScope}` : null, id);
  if (decision === "approved" && allowScope !== "once" && row.bot_id) {
    if (allowScope === "conversation" && row.conversation_id) {
      db.prepare("INSERT OR IGNORE INTO approval_allows (scope, conversation_id, bot_id, tool, created_at) VALUES ('conversation',?,?,?,?)")
        .run(row.conversation_id, row.bot_id, row.tool, now());
    } else if (allowScope === "always") {
      db.prepare("INSERT OR IGNORE INTO approval_allows (scope, conversation_id, bot_id, tool, created_at) VALUES ('bot','',?,?,?)")
        .run(row.bot_id, row.tool, now());
    }
  }
  const waiter = waiters.get(id);
  if (waiter) {
    clearTimeout(waiter.timer);
    waiters.delete(id);
    waiter.resolve(decision);
  }
  broadcast({ type: "approval.decided", id, status: decision });
  return { ok: true };
}

/** Create a pending approval and block the calling tool execution until decided or expired. */
export async function requestApproval(
  ctx: { bot: { id: string }; conversationId: string | null },
  tool: string,
  args: Record<string, unknown>
): Promise<ApprovalVerdict> {
  const id = uid();
  db.prepare(
    "INSERT INTO approvals (id, bot_id, conversation_id, tool, args, status, created_at) VALUES (?,?,?,?,?,'pending',?)"
  ).run(id, ctx.bot.id, ctx.conversationId, tool, JSON.stringify(args).slice(0, 2000), now());
  broadcast({ type: "approval.requested", approval: getApproval(id) });

  const verdict = await new Promise<ApprovalVerdict>((resolve) => {
    const timer = setTimeout(() => {
      waiters.delete(id);
      db.prepare("UPDATE approvals SET status='expired', decided_at=? WHERE id=? AND status='pending'").run(now(), id);
      broadcast({ type: "approval.decided", id, status: "expired" });
      resolve("expired");
    }, APPROVAL_TIMEOUT_MS);
    waiters.set(id, { resolve, timer });
  });
  return verdict;
}

/** No waiter survives a restart: undecided requests become denials-equivalent (expired). */
export function expirePendingOnBoot(): void {
  const r = db.prepare("UPDATE approvals SET status='expired', detail='server restart', decided_at=? WHERE status='pending'").run(now());
  if (r.changes > 0) console.log(`[openbot] expired ${r.changes} pending approval(s) from before restart`);
}
