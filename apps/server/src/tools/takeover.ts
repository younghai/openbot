import { registerTool, type ToolContext } from "./gateway.js";
import { requestApprovalDetailed, requestApproval, takeApprovalSecret } from "../approvals.js";
import { db, uid, now } from "../db.js";
import { parseCron } from "../cron.js";
import { broadcast } from "../events.js";
import { sessionForStream, proxyAction, injectSecret, findSessionPage } from "./browser.js";

/**
 * 사람 제어권 이관 + 능동 질문 + 루틴 자기관리 (CopilotKit OpenBot 패턴, 2026-11-15).
 *
 * - computer.request_help: 봇이 로그인·CAPTCHA·2FA 같은 사람 필요 단계에 도달하면 호출.
 *   승인 카드에서 "내가 직접 수행"을 누르면 제어권이 사람에게 넘어가고(라이브 패널에서
 *   클릭·입력 가능), 반납 버튼을 누르면 봇이 같은 세션에서 이어서 진행한다.
 *   승인 거부/만료면 사람이 안 했다는 한 문장으로 돌아간다 (우회 금지).
 * - computer.request_secret: 비밀번호·카드번호 한 필드만 마스크 박스로 직주입. 봇은 값을 못 본다.
 * - ask_person: 도구 승인과 별개로 판단 질문을 능동적으로 던진다 (CK ask_person).
 * - routine.create/list/delete: 봇이 대화에서 스스로 루틴을 만들고 관리한다 (CK create_routine).
 */

// ---------------------------------------------------------------- takeover 상태

const takeoverActive = new Map<string, () => void>(); // key(computer:bot) → release resolver
const TAKEOVER_TIMEOUT_MS = 5 * 60_000;

function tkey(ctx: ToolContext): string {
  return `${ctx.computer.id}:${ctx.bot.id}`;
}

export function takeoverIsActive(computerId: string, botId: string): boolean {
  return takeoverActive.has(`${computerId}:${botId}`);
}

export function releaseTakeover(computerId: string, botId: string): boolean {
  const key = `${computerId}:${botId}`;
  const resolve = takeoverActive.get(key);
  if (!resolve) return false;
  takeoverActive.delete(key);
  resolve();
  broadcast({ type: "takeover.ended", computerId, botId });
  return true;
}

function waitForRelease(key: string, timeoutMs: number): Promise<"released" | "timeout"> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      takeoverActive.delete(key);
      resolve("timeout");
    }, timeoutMs);
    takeoverActive.set(key, () => {
      clearTimeout(timer);
      resolve("released");
    });
  });
}

// ---------------------------------------------------------------- computer.request_help

registerTool({
  name: "computer.request_help",
  description:
    "사람에게 브라우저 직접 조작을 요청합니다. 로그인·비밀번호·CAPTCHA·2FA·결제 확인처럼 봇이 할 수 없거나 하면 안 되는 단계에 도달했을 때 호출하세요. " +
    "호출하면 사람에게 요청 카드가 가고, 사람이 '내가 직접 수행'을 누르면 라이브 패널에서 그 단계를 직접 하고 반납합니다. 같은 세션이 유지되므로 반납 후 계속 진행하세요. " +
    "대화로 '로그인해 주세요'라고 말하는 것은 요청이 아닙니다 — 이 도구를 호출해야 사람에게 화면이 전달됩니다.",
  parameters: {
    type: "object",
    properties: {
      reason: { type: "string", description: "무엇을 왜 사람이 해야 하는지 한 문장" },
    },
    required: ["reason"],
  },
  async execute(ctx, args) {
    const reason = String(args.reason ?? "").slice(0, 300);
    if (!reason.trim()) throw new Error("reason required");
    const key = tkey(ctx);
    let currentUrl = "";
    try {
      const page = await sessionForStream(ctx);
      currentUrl = (await page?.url()) ?? "";
    } catch { /* 세션 없어도 요청 가능 */ }

    // 도구 자체가 승인 카드를 만든다 — 프리셋은 이 도구를 allow로 둔다(이중 질문 방지)
    const verdict = await requestApproval(ctx, "computer.request_help", { reason, url: currentUrl });
    if (verdict === "denied" || verdict === "expired") {
      return {
        done: false,
        note: verdict === "denied"
          ? "사람이 이 요청을 거부했습니다. 그 단계 없이 진행하거나, 그래도 못 한다고 정직하게 보고하세요. 우회를 시도하지 마세요."
          : "요청에 10분간 응답이 없어 만료되었습니다. 사람이 안 했으니 그대로 보고하세요.",
      };
    }

    // 승인 = 사람이 '내가 직접 수행' 선택 → 제어권 이관, 반납 대기
    const page = await sessionForStream(ctx);
    if (!page) return { done: false, note: "브라우저 세션이 열려 있지 않아 제어권을 넘길 수 없습니다. 먼저 browser.open을 호출하세요." };
    broadcast({ type: "takeover.started", computerId: ctx.computer.id, botId: ctx.bot.id, reason });
    const outcome = await waitForRelease(key, TAKEOVER_TIMEOUT_MS);
    if (outcome === "timeout") {
      broadcast({ type: "takeover.ended", computerId: ctx.computer.id, botId: ctx.bot.id, timeout: true });
      return { done: false, note: "사람이 5분 안에 반납하지 않았습니다. 작업이 끝났는지 확인하고 계속하세요." };
    }
    return {
      done: true,
      done_by_person: true,
      note: "사람이 직접 수행하고 반납했습니다. 현재 페이지 상태를 browser.snapshot으로 확인한 뒤 이어서 진행하세요.",
    };
  },
});

// ---------------------------------------------------------------- computer.request_secret

registerTool({
  name: "computer.request_secret",
  description:
    "비밀번호·인증코드·카드번호 같은 기밀 값 한 필드를 사람에게 직접 입력받습니다. 마스크 박스가 열리고 사람이 입력한 값은 페이지 필드로 곧장 주입됩니다 — 봇은 값을 절대 보지 못합니다. " +
    "전체 화면 조작이 필요하면 computer.request_help를 쓰세요.",
  parameters: {
    type: "object",
    properties: {
      selector: { type: "string", description: "CSS selector of the password/secret input field" },
      label: { type: "string", description: "사람에게 보여줄 라벨 (예: 'GitHub 비밀번호')" },
    },
    required: ["selector", "label"],
  },
  async execute(ctx, args) {
    const selector = String(args.selector ?? "");
    const label = String(args.label ?? "기밀 값").slice(0, 120);
    if (!selector) throw new Error("selector required");
    const page = await findSessionPage(ctx.computer.id, ctx.bot.id);
    if (!page) return { filled: false, note: "브라우저 세션이 없습니다. 먼저 browser.open을 호출하세요." };

    const { verdict, id } = await requestApprovalDetailed(ctx, "computer.request_secret", { label, selector, url: await page.url() });
    const secret = verdict === "approved" ? takeApprovalSecret(id) : undefined;
    if (verdict !== "approved" || secret === undefined) {
      return { filled: false, note: "사람이 기밀 입력을 하지 않았습니다(거부 또는 만료). 값 없이 진행하거나 정직하게 보고하세요. 추측하지 마세요." };
    }
    const injected = await injectSecret(ctx.computer.id, ctx.bot.id, selector, secret);
    return injected.ok
      ? { filled: true, note: "사람이 값을 직접 입력해 필드에 주입했습니다. 값을 보지 못했습니다 — 이어서 진행하세요." }
      : { filled: false, error: injected.error };
  },
});

// ---------------------------------------------------------------- ask_person

registerTool({
  name: "ask_person",
  description:
    "사람에게 판단 질문을 던집니다. 도구 승인과 별개로, 요구사항이 모호하거나 선택지 중 결정이 필요할 때 사용하세요. 답변은 알림으로 전달되고 다음 메시지로 도착합니다.",
  parameters: {
    type: "object",
    properties: {
      question: { type: "string", description: "한 문장 질문" },
      options: { type: "string", description: "선택지 (쉼표 구분, 선택사항)" },
    },
    required: ["question"],
  },
  async execute(ctx, args) {
    const question = String(args.question ?? "").slice(0, 500);
    if (!question.trim()) throw new Error("question required");
    const options = String(args.options ?? "").slice(0, 300);
    db.prepare("INSERT INTO notifications (id, kind, title, body, created_at) VALUES (?,?,?,?,?)").run(
      uid(), "ask_person", `${ctx.bot.name}: ${question}`, options ? `선택지: ${options}` : "", now()
    );
    broadcast({ type: "notification.created", kind: "ask_person", question });
    return {
      asked: true,
      guidance: "질문이 사람에게 전달되었습니다. 이번 턴을 마치고 답변을 기다리세요 — 임의로 진행하지 말고, 정말 기다릴 수 없는 사안이라면 그 이유와 함께 기본값을 제안하세요.",
    };
  },
});

// ---------------------------------------------------------------- 루틴 자기관리

registerTool({
  name: "routine.create",
  description: "이 봇에게 반복 작업(루틴)을 만듭니다. '매주 월요일 아침에...'처럼 사람이 말하면 이 도구로 스스로 등록하세요.",
  parameters: {
    type: "object",
    properties: {
      cron: { type: "string", description: "5-field cron (분 시 일 월 요일), e.g. 0 9 * * 1-5" },
      prompt: { type: "string", description: "매 실행 시 수행할 지시문" },
      name: { type: "string", description: "루틴 이름" },
      mode: { type: "string", description: "act(실행, 기본) | report(보고만)" },
      goal: { type: "string", description: "목표 — 달성 판정 시 자동 중지 (선택)" },
      trigger_key: { type: "string", description: "이벤트 트리거 키 — POST /api/triggers/:key 로 즉시 발화 가능 (선택)" },
    },
    required: ["cron", "prompt"],
  },
  async execute(ctx, args) {
    const cron = String(args.cron ?? "");
    try { parseCron(cron); } catch (err) { throw new Error(`잘못된 cron: ${err instanceof Error ? err.message : String(err)}`); }
    const prompt = String(args.prompt ?? "");
    if (!prompt.trim()) throw new Error("prompt required");
    const mode = args.mode === "report" ? "report" : "act";
    const id = uid();
    db.prepare("INSERT INTO routines (id, bot_id, name, cron, prompt, enabled, failure_count, created_at, mode, goal, trigger_key) VALUES (?,?,?,?,?,1,0,?,?,?,?)").run(
      id, ctx.bot.id, String(args.name ?? cron).slice(0, 120), cron, prompt.slice(0, 8000), now(), mode,
      args.goal ? String(args.goal).slice(0, 2000) : null,
      args.trigger_key ? String(args.trigger_key).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 60) : null,
    );
    return { created: true, routineId: id, note: "루틴이 등록되었습니다. 사람이 루틴 페이지에서 끌 수 있습니다." };
  },
});

registerTool({
  name: "routine.list",
  description: "이 봇의 등록된 루틴 목록을 봅니다.",
  parameters: { type: "object", properties: {} },
  async execute(ctx) {
    const rows = db.prepare("SELECT id, name, cron, prompt, mode, goal, enabled, trigger_key FROM routines WHERE bot_id=? ORDER BY created_at DESC LIMIT 50").all(ctx.bot.id);
    return { routines: rows };
  },
});

registerTool({
  name: "routine.delete",
  description: "이 봇의 루틴을 삭제합니다. 사람이 '그 루틴 없애줘'라고 하면 사용하세요. 삭제는 승인을 요구합니다.",
  parameters: {
    type: "object",
    properties: { routineId: { type: "string", description: "routine.list에서 얻은 id" } },
    required: ["routineId"],
  },
  async execute(ctx, args) {
    const row = db.prepare("SELECT id FROM routines WHERE id=? AND bot_id=?").get(String(args.routineId ?? ""), ctx.bot.id);
    if (!row) return { deleted: false, note: "그 루틴이 없습니다. routine.list로 확인하세요." };
    db.prepare("DELETE FROM routines WHERE id=?").run(String(args.routineId));
    return { deleted: true };
  },
});
