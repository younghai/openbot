import { db } from "./db.js";
import { onEvent } from "./events.js";
import { enqueueFromHttp } from "./chat.js";
import { getOrCreateDmConversation } from "./agent/loop.js";
import { decideApproval } from "./approvals.js";
import { notify } from "./notifications.js";
import { credentialFor } from "./voice.js";

/**
 * Telegram channel gateway (QwenPaw/dinobot pattern, our implementation):
 * long-poll getUpdates, route messages into a bound bot's DM, push assistant
 * replies back, and surface approval requests as inline 승인/거부 buttons —
 * remote control of the approval queue. Needs TELEGRAM_BOT_TOKEN in the
 * credential store; TELEGRAM_API_BASE overrides the API host for tests.
 */

interface TgUpdate {
  update_id: number;
  message?: { chat: { id: number }; message_id?: number; from?: { id: number; first_name?: string }; text?: string };
  callback_query?: { id: string; data: string; from?: { id: number }; message?: { chat: { id: number }; message_id: number } };
}

/** Telegram user allowlist (deepseek-bot pattern): TELEGRAM_ALLOWED_USERS credential,
 * comma-separated numeric ids. Empty = open (with a boot warning). */
function allowedUsers(): Set<number> {
  const raw = credentialFor("TELEGRAM_ALLOWED_USERS") ?? "";
  return new Set(raw.split(",").map((x) => Number(x.trim())).filter((n) => Number.isFinite(n) && n > 0));
}

function userAllowed(id: number | undefined): boolean {
  const allow = allowedUsers();
  if (allow.size === 0) return true;
  return id !== undefined && allow.has(id);
}

const chatBinds = new Map<number, string>(); // telegram chat id -> bot id
const lastIncomingByChat = new Map<number, number>();
let running = false;
let offset = 0;

function token(): string | null {
  return credentialFor("TELEGRAM_BOT_TOKEN") ?? null;
}

async function tg(method: string, body?: Record<string, unknown>): Promise<unknown> {
  const base = process.env.TELEGRAM_API_BASE ?? "https://api.telegram.org";
  const res = await fetch(`${base}/bot${token()}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`telegram ${method} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

function bindTarget(): string | null {
  const row = db.prepare("SELECT id FROM bots WHERE status='active' ORDER BY created_at LIMIT 1").get() as { id: string } | undefined;
  return row?.id ?? null;
}

async function handleUpdate(u: TgUpdate): Promise<void> {
  if (u.message?.text) {
    const chatId = u.message.chat.id;
    const text = u.message.text.trim();
    if (!userAllowed(u.message.from?.id)) {
      await tg("sendMessage", { chat_id: chatId, text: "등록되지 않은 사용자입니다. 이 봇은 허용목록(TELEGRAM_ALLOWED_USERS)에 등록된 사용자만 사용할 수 있습니다." }).catch(() => undefined);
      return;
    }
    if (text === "/start" || text.startsWith("/bot")) {
      const target = text.startsWith("/bot ")
        ? (db.prepare("SELECT id FROM bots WHERE name=? COLLATE NOCASE").get(text.slice(5).trim()) as { id: string } | undefined)?.id
        : bindTarget();
      if (!target) {
        await tg("sendMessage", { chat_id: chatId, text: "연결할 봇이 없습니다. 먼저 OpenBot에서 봇을 만들어 주세요." });
        return;
      }
      chatBinds.set(chatId, target);
      const bot = db.prepare("SELECT name FROM bots WHERE id=?").get(target) as { name: string };
      await tg("sendMessage", { chat_id: chatId, text: `연결됨: ${bot.name}. 메시지를 보내면 이 봇이 답합니다.` });
      return;
    }
    const botId = chatBinds.get(chatId) ?? bindTarget();
    if (!botId) return;
    const conv = getOrCreateDmConversation(botId);
    lastIncomingByChat.set(chatId, u.message.message_id ?? 0);
    void tg("setMessageReaction", { chat_id: chatId, message_id: u.message.message_id ?? 0, emoji: "\ud83d\udc40" }).catch(() => undefined);
    await enqueueFromHttp(conv.id, text);
    return;
  }
  if (u.callback_query) {
    const cb = u.callback_query;
    if (!userAllowed(cb.from?.id)) {
      await tg("answerCallbackQuery", { callback_query_id: cb.id }).catch(() => undefined);
      return;
    }
    const [, kind, id] = String(cb.data).split(":");
    await tg("answerCallbackQuery", { callback_query_id: cb.id }).catch(() => undefined);
    if (kind === "ap" || kind === "dn") {
      const r = decideApproval(id, kind === "ap" ? "approved" : "denied");
      await tg("sendMessage", { chat_id: cb.message?.chat.id, text: r.ok ? (kind === "ap" ? "✅ 승인했습니다." : "🚫 거부했습니다.") : `이미 처리됨: ${r.error}` }).catch(() => undefined);
    }
  }
}

/** Push assistant replies + approval requests for bound conversations. */
function wireOutbound(): void {
  onEvent((event) => {
    const e = event as Record<string, unknown>;
    if (e.type === "chat.message" && e.role === "assistant" && typeof e.content === "string" && e.content) {
      for (const [chatId, botId] of chatBinds) {
        const conv = getOrCreateDmConversation(botId);
        if (e.conversationId === conv.id && e.botId === botId) {
          void tg("sendMessage", { chat_id: chatId, text: (e.content as string).slice(0, 3800) }).catch(() => undefined);
          const lastIncoming = lastIncomingByChat.get(chatId);
          if (lastIncoming) void tg("setMessageReaction", { chat_id: chatId, message_id: lastIncoming, emoji: "\ud83d\udc4c" }).catch(() => undefined);
        }
      }
    }
    if (e.type === "approval.requested") {
      const approval = e.approval as { id: string; tool: string; args: string | null; conversation_id: string | null } | undefined;
      if (!approval) return;
      for (const [chatId] of chatBinds) {
        void tg("sendMessage", {
          chat_id: chatId,
          text: `🔒 도구 승인 요청: ${approval.tool}\n${(approval.args ?? "").slice(0, 300)}`,
          reply_markup: { inline_keyboard: [[
            { text: "승인", callback_data: `tg:ap:${approval.id}` },
            { text: "거부", callback_data: `tg:dn:${approval.id}` },
          ]] },
        }).catch(() => undefined);
      }
    }
  });
}

export function startTelegramGateway(): void {
  if (running) return;
  if (!token()) return;
  running = true;
  wireOutbound();
  notify("system", "Telegram 채널 연결됨", "메시지가 봇으로, 승인 요청이 버튼으로 전달됩니다.");
  void (async function poll(): Promise<void> {
    for (;;) {
      try {
        if (!token()) { running = false; return; }
        const res = (await tg("getUpdates", { offset, timeout: 25 })) as { result?: TgUpdate[] };
        for (const u of res.result ?? []) {
          offset = Math.max(offset, u.update_id + 1);
          await handleUpdate(u);
        }
      } catch {
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  })();
}

// re-check for a token every minute (credential can be set later)
/** Called by the credentials route when TELEGRAM_BOT_TOKEN is saved. */
export function ensureTelegramGateway(): void {
  if (!running && token()) startTelegramGateway();
}

setInterval(() => {
  if (!running && token()) startTelegramGateway();
}, 15_000).unref?.();
