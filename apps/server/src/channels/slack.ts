import { db } from "../db.js";
import { onEvent } from "../events.js";
import { enqueueFromHttp } from "../chat.js";
import { getOrCreateDmConversation } from "../agent/loop.js";
import { decideApproval } from "../approvals.js";
import { notify } from "../notifications.js";
import { credentialFor } from "../voice.js";

/**
 * Slack channel gateway (OpenClaw pattern): Socket Mode for real-time messages,
 * Block Actions for remote approval buttons. Needs SLACK_BOT_TOKEN (xoxb-)
 * and SLACK_APP_TOKEN (xapp-) credentials.
 */

const channelBinds = new Map<string, string>(); // slack channel id -> bot id
let running = false;
let ws: WebSocket | null = null;
let pingTimer: ReturnType<typeof setInterval> | null = null;

function botToken(): string | null { return credentialFor("SLACK_BOT_TOKEN") ?? null; }
function appToken(): string | null { return credentialFor("SLACK_APP_TOKEN") ?? null; }

async function api(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`https://slack.com/api${path}`, {
    method,
    headers: { authorization: `Bearer ${botToken()}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await res.json()) as { ok: boolean; error?: string };
  if (!json.ok) throw new Error(`Slack ${path}: ${json.error}`);
  return json;
}

async function sendText(channel: string, text: string): Promise<void> {
  // split long messages (Slack limit: ~40000, keep readable at 3500)
  const parts: string[] = [];
  let rest = text;
  while (rest.length > 3500) {
    const cut = rest.lastIndexOf("\n", 3500) > 1000 ? rest.lastIndexOf("\n", 3500) : 3500;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) parts.push(rest);
  for (let i = 0; i < parts.length; i++) {
    const content = parts.length > 1 ? `${parts[i]}\n(${i + 1}/${parts.length})` : parts[i];
    await api("POST", "/chat.postMessage", { channel, text: content }).catch(() => undefined);
  }
}

async function handleEvent(event: Record<string, unknown>): Promise<void> {
  if (event.type === "message" && !event.subtype) {
    const channel = String(event.channel ?? "");
    const text = String(event.text ?? "").trim();
    const userId = String(event.user ?? "");
    if (!text || userId === "USLACKBOT") return;

    const bindTarget = (): string | null => {
      const row = db.prepare("SELECT id FROM bots WHERE status='active' ORDER BY created_at LIMIT 1").get() as { id: string } | undefined;
      return row?.id ?? null;
    };

    if (text === "/start" || text.startsWith("/bind")) {
      const target = text.startsWith("/bind ") ? db.prepare("SELECT id FROM bots WHERE name=? COLLATE NOCASE").get(text.slice(5).trim()) as { id: string } | undefined : undefined;
      const botId = target?.id ?? bindTarget();
      if (!botId) { await sendText(channel, "연결할 봇이 없습니다."); return; }
      channelBinds.set(channel, botId);
      const bot = db.prepare("SELECT name FROM bots WHERE id=?").get(botId) as { name: string };
      await sendText(channel, `연결됨: ${bot.name}. 메시지를 보내면 이 봇이 답합니다.`);
      return;
    }

    const botId = channelBinds.get(channel) ?? bindTarget();
    if (!botId) return;
    const conv = getOrCreateDmConversation(botId);
    await enqueueFromHttp(conv.id, text);
  }

  if (event.type === "block_actions") {
    const actions = event.actions as { action_id: string; value?: string }[] | undefined;
    for (const action of actions ?? []) {
      const [, kind, approvalId] = action.action_id.split(":");
      if (kind === "ap" || kind === "dn") {
        decideApproval(approvalId, kind === "ap" ? "approved" : "denied");
        const ch = (event.channel as { id: string })?.id;
        if (ch) await sendText(ch, kind === "ap" ? "✅ 승인했습니다." : "🚫 거부했습니다.");
      }
    }
  }
}

function wireOutbound(): void {
  onEvent((event) => {
    const e = event as Record<string, unknown>;
    if (e.type === "chat.message" && e.role === "assistant" && typeof e.content === "string" && e.content) {
      for (const [channel, botId] of channelBinds) {
        const conv = getOrCreateDmConversation(botId);
        if (e.conversationId === conv.id && e.botId === botId) {
          void sendText(channel, (e.content as string).slice(0, 3500));
        }
      }
    }
    if (e.type === "approval.requested") {
      const approval = e.approval as { id: string; tool: string; args: string | null } | undefined;
      if (!approval) return;
      for (const [channel] of channelBinds) {
        void api("POST", "/chat.postMessage", {
          channel,
          text: `🔒 도구 승인 요청: *${approval.tool}*`,
          blocks: [
            { type: "section", text: { type: "mrkdwn", text: `🔒 *${approval.tool}*\n\`\`\`${(approval.args ?? "").slice(0, 250)}\`\`\`` } },
            { type: "actions", elements: [
              { type: "button", style: "primary", text: { type: "plain_text", text: "승인" }, action_id: `sl:ap:${approval.id}` },
              { type: "button", style: "danger", text: { type: "plain_text", text: "거부" }, action_id: `sl:dn:${approval.id}` },
            ] },
          ],
        }).catch(() => undefined);
      }
    }
  });
}

export function startSlackGateway(): void {
  if (running || !botToken() || !appToken()) return;
  running = true;
  wireOutbound();
  notify("system", "Slack 채널 연결됨", "메시지가 봇으로, 승인 요청이 버튼으로 전달됩니다.");

  // Polling-based: check for new messages every 3s via conversations.history
  void (async function poll(): Promise<void> {
    const lastTs = new Map<string, string>(); // channel -> last seen ts
    for (;;) {
      try {
        if (!botToken() || !appToken()) { running = false; return; }
        for (const [channel] of channelBinds) {
          const params = new URLSearchParams({ channel, limit: "5" });
          const since = lastTs.get(channel);
          if (since) params.set("oldest", String(parseFloat(since) + 0.001));
          const res = await fetch(`https://slack.com/api/conversations.history?${params}`, {
            headers: { authorization: `Bearer ${botToken()}` },
            signal: AbortSignal.timeout(10_000),
          });
          const json = (await res.json()) as { ok: boolean; messages?: { ts: string; text: string; user: string; bot_id?: string }[] };
          if (json.ok && json.messages) {
            const sorted = json.messages.sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts));
            for (const msg of sorted) {
              lastTs.set(channel, msg.ts);
              if (msg.bot_id || msg.user === "USLACKBOT") continue;
              if (msg.text.trim()) {
                await handleEvent({ type: "message", channel, text: msg.text, user: msg.user, ts: msg.ts });
              }
            }
          }
        }
        await new Promise((r) => setTimeout(r, 3000));
      } catch {
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  })();
}

setInterval(() => { if (!running && botToken() && appToken()) startSlackGateway(); }, 15_000).unref?.();
