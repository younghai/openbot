import { Hono } from "hono";
import { db, uid, now } from "../db.js";
import { setApprovalSecret, decideApproval } from "../approvals.js";
import { releaseTakeover } from "../tools/takeover.js";
import { proxyAction } from "../tools/browser.js";
import { broadcast } from "../events.js";

/**
 * 라이브 브라우저 제어권 라우트 + 이벤트 트리거 (CK computer panel 패턴).
 * - 제어권 이관 중(person takeover)에만 act 허용 — 봇 페이지에 사람 입력을 프록시
 * - 시크릿 직주입: 승인 카드에서 입력 → 도구가 필드에 주입, 값은 로그에 남지 않는다
 * - 트리거: cron 외 발화원 — POST /api/triggers/:key 로 trigger_key 루틴 즉시 발화
 */
export const browserRouter = new Hono();

/** 봇의 컴퓨터 해석 — runAgent과 같은 규칙(bot.computer_id → 기본 Team Computer) */
async function computerIdForBot(botId: string): Promise<string | null> {
  const bot = db.prepare("SELECT computer_id FROM bots WHERE id=?").get(botId) as { computer_id: string | null } | undefined;
  if (bot?.computer_id) return bot.computer_id;
  const team = db.prepare("SELECT id FROM computers WHERE name='Team Computer' AND kind='team' LIMIT 1").get() as { id: string } | undefined;
  return team?.id ?? null;
}

browserRouter.post("/browser/release", async (c) => {
  const body = await c.req.json<{ computerId?: string; botId?: string }>();
  const botId = String(body.botId ?? "");
  const computerId = String(body.computerId ?? "") || (botId ? ((await computerIdForBot(botId)) ?? "") : "");
  const released = releaseTakeover(computerId, botId);
  return c.json({ ok: released }, released ? 200 : 409);
});

browserRouter.post("/browser/act", async (c) => {
  const body = await c.req.json<{ computerId?: string; botId?: string; action?: { kind: string; x?: number; y?: number; text?: string; selector?: string } }>();
  const { takeoverIsActive } = await import("../tools/takeover.js");
  const botId = String(body.botId ?? "");
  const computerId = String(body.computerId ?? "") || (botId ? ((await computerIdForBot(botId)) ?? "") : "");
  if (!takeoverIsActive(computerId, botId)) {
    return c.json({ ok: false, error: "제어권이 봇에 있습니다 — request_help 승인 후 사용하세요" }, 409);
  }
  const r = await proxyAction(computerId, botId, (body.action ?? {}) as never);
  return c.json(r, r.ok ? 200 : 400);
});

browserRouter.post("/browser/secret", async (c) => {
  const body = await c.req.json<{ approvalId?: string; secret?: string }>();
  const id = String(body.approvalId ?? "");
  const secret = String(body.secret ?? "");
  if (!id || !secret) return c.json({ ok: false, error: "approvalId/secret required" }, 400);
  if (secret.length > 1000) return c.json({ ok: false, error: "secret too long" }, 400);
  setApprovalSecret(id, secret);
  const r = decideApproval(id, "approved");
  return c.json(r, r.ok ? 200 : 409); // 값은 응답에 절대 포함하지 않는다
});

// ---------------------------------------------------------------- 이벤트 트리거

browserRouter.post("/triggers/:key", async (c) => {
  const key = c.req.param("key").replace(/[^a-zA-Z0-9_-]/g, "");
  if (!key) return c.json({ error: "invalid trigger key" }, 400);
  const routines = db.prepare("SELECT * FROM routines WHERE trigger_key=? AND enabled=1").all(key) as unknown as { id: string; bot_id: string; name: string; prompt: string }[];
  if (routines.length === 0) return c.json({ fired: 0 }, 404);
  const { getOrCreateDmConversation, insertMessage } = await import("../agent/loop.js");
  const { enqueueJob } = await import("../queue.js");
  let fired = 0;
  for (const r of routines) {
    try {
      const conv = getOrCreateDmConversation(r.bot_id);
      insertMessage(conv.id, r.bot_id, "user", `[trigger: ${key}] ${r.prompt}`, { meta: { source: "routine", routineId: r.id } });
      enqueueJob(r.bot_id, conv.id, r.prompt, "routine", r.id);
      db.prepare("UPDATE routines SET last_run_at=? WHERE id=?").run(now(), r.id);
      fired++;
    } catch { /* 봇 잠김 등 — 다음 트리거에 재시도 */ }
  }
  broadcast({ type: "trigger.fired", key, fired });
  return c.json({ fired });
});
