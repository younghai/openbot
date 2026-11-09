import { db } from "../db.js";
import { onEvent } from "../events.js";
import { enqueueFromHttp } from "../chat.js";
import { getOrCreateDmConversation, insertMessage } from "../agent/loop.js";
import { decideApproval } from "../approvals.js";
import { notify } from "../notifications.js";
import { credentialFor } from "../voice.js";

/**
 * Discord channel gateway (OpenClaw pattern): WebSocket Gateway for messages,
 * interaction buttons for remote approval. Needs DISCORD_BOT_TOKEN credential.
 * DISCORD_ALLOWED_GUILDS (comma-separated guild ids) restricts which servers.
 */

interface DiscordMessage {
  id: string;
  content: string;
  channel_id: string;
  author: { id: string; username: string; bot: boolean };
  member?: { nick?: string };
}

const channelBinds = new Map<string, string>(); // discord channel id -> bot id
let running = false;
let ws: WebSocket | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let sequence: number | null = null;
let sessionId = "";

function token(): string | null {
  return credentialFor("DISCORD_BOT_TOKEN") ?? null;
}

function allowedGuilds(): Set<string> {
  const raw = credentialFor("DISCORD_ALLOWED_GUILDS") ?? "";
  return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
}

async function api(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`https://discord.com/api/v10${path}`, {
    method,
    headers: { authorization: `Bot ${token()}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Discord ${method} ${path} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.status === 204 ? undefined : res.json();
}

async function sendMessage(channelId: string, content: string): Promise<void> {
  // split long messages (Discord limit: 2000)
  const parts: string[] = [];
  let rest = content;
  while (rest.length > 1900) {
    const cut = rest.lastIndexOf("\n", 1900) > 1000 ? rest.lastIndexOf("\n", 1900) : 1900;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) parts.push(rest);
  for (let i = 0; i < parts.length; i++) {
    const text = parts.length > 1 ? `${parts[i]}\n(${i + 1}/${parts.length})` : parts[i];
    await api("POST", `/channels/${channelId}/messages`, { content: text }).catch(() => undefined);
  }
}

async function handleInteraction(data: Record<string, unknown>): Promise<void> {
  const type = data.type as number;
  if (type === 1) {
    // pong
    return;
  }
  if (type === 3) {
    // component interaction (button click)
    const message = data.message as { channel_id: string; content: string } | undefined;
    const customId = (data.data as { custom_id?: string })?.custom_id ?? "";
    const [, kind, approvalId] = customId.split(":");
    if (kind === "ap" || kind === "dn") {
      await api("POST", `/interactions/${data.id}/${data.token}/callback`, {
        type: 4, // channel message with source
        data: { content: kind === "ap" ? "✅ 승인했습니다." : "🚫 거부했습니다.", flags: 64 },
      }).catch(() => undefined);
      decideApproval(approvalId, kind === "ap" ? "approved" : "denied");
    }
  }
}

async function handleMessage(msg: DiscordMessage): Promise<void> {
  if (msg.author.bot) return;
  const text = msg.content.trim();
  if (!text) return;

  const bindTarget = (): string | null => {
    const row = db.prepare("SELECT id FROM bots WHERE status='active' ORDER BY created_at LIMIT 1").get() as { id: string } | undefined;
    return row?.id ?? null;
  };

  if (text === "/start" || text.startsWith("/bind")) {
    const target = text.startsWith("/bind ") ? db.prepare("SELECT id FROM bots WHERE name=? COLLATE NOCASE").get(text.slice(5).trim()) as { id: string } | undefined : undefined;
    const botId = target?.id ?? bindTarget();
    if (!botId) { await sendMessage(msg.channel_id, "연결할 봇이 없습니다."); return; }
    channelBinds.set(msg.channel_id, botId);
    const bot = db.prepare("SELECT name FROM bots WHERE id=?").get(botId) as { name: string };
    await sendMessage(msg.channel_id, `연결됨: ${bot.name}. 메시지를 보내면 이 봇이 답합니다.`);
    return;
  }

  const botId = channelBinds.get(msg.channel_id) ?? bindTarget();
  if (!botId) return;
  const conv = getOrCreateDmConversation(botId);
  await enqueueFromHttp(conv.id, text);
}

function wireOutbound(): void {
  onEvent((event) => {
    const e = event as Record<string, unknown>;
    if (e.type === "chat.message" && e.role === "assistant" && typeof e.content === "string" && e.content) {
      for (const [channelId, botId] of channelBinds) {
        const conv = getOrCreateDmConversation(botId);
        if (e.conversationId === conv.id && e.botId === botId) {
          void sendMessage(channelId, (e.content as string).slice(0, 3800));
        }
      }
    }
    if (e.type === "approval.requested") {
      const approval = e.approval as { id: string; tool: string; args: string | null } | undefined;
      if (!approval) return;
      for (const [channelId] of channelBinds) {
        void api("POST", `/channels/${channelId}/messages`, {
          content: `🔒 도구 승인 요청: **${approval.tool}**\n\`\`\`${(approval.args ?? "").slice(0, 300)}\`\`\``,
          components: [{
            type: 1, components: [
              { type: 2, style: 3, label: "승인", custom_id: `dc:ap:${approval.id}` },
              { type: 2, style: 4, label: "거부", custom_id: `dc:dn:${approval.id}` },
            ],
          }],
        }).catch(() => undefined);
      }
    }
  });
}

export function startDiscordGateway(): void {
  if (running || !token()) return;
  running = true;
  wireOutbound();
  notify("system", "Discord 채널 연결됨", "메시지가 봇으로, 승인 요청이 버튼으로 전달됩니다.");

  void (async function connect(): Promise<void> {
    try {
      if (!token()) { running = false; return; }
      const gw = (await api("GET", "/gateway")) as { url: string };
      ws = new WebSocket(gw.url);
      ws.onopen = () => {
        ws?.send(JSON.stringify({
          op: 2, // IDENTIFY
          d: { token: token(), intents: 512 | 32768 }, // GUILD_MESSAGES | MESSAGE_COMPONENTS
          properties: { $os: "macos", $browser: "openbot", $device: "openbot" },
        }));
      };
      ws.onmessage = (ev) => {
        try {
          const payload = JSON.parse(String(ev.data)) as { op: number; s: number | null; t: string | null; d: unknown };
          if (payload.s) sequence = payload.s;
          if (payload.op === 10) {
            const hb = (payload.d as { heartbeat_interval: number }).heartbeat_interval;
            heartbeatTimer = setInterval(() => {
              ws?.send(JSON.stringify({ op: 1, d: sequence }));
            }, hb);
            if (sessionId) {
              ws?.send(JSON.stringify({ op: 6, d: { token: token(), session_id: sessionId, seq: sequence } }));
            } else {
              ws?.send(JSON.stringify({
                op: 2,
                d: { token: token(), intents: 512 | 32768, properties: { $os: "macos", $browser: "openbot", $device: "openbot" } },
              }));
            }
          }
          if (payload.op === 0) {
            if (payload.t === "READY") {
              sessionId = (payload.d as { session_id: string }).session_id;
            }
            if (payload.t === "MESSAGE_CREATE") void handleMessage(payload.d as DiscordMessage);
            if (payload.t === "INTERACTION_CREATE") void handleInteraction(payload.d as Record<string, unknown>);
          }
          if (payload.op === 7) { ws?.close(); }
          if (payload.op === 9) {
            sessionId = "";
            setTimeout(() => { if (running) void connect(); }, 2000);
          }
        } catch { /* malformed */ }
      };
      ws.onclose = () => {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        setTimeout(() => { if (running) void connect(); }, 5000);
      };
    } catch {
      await new Promise((r) => setTimeout(r, 5000));
      if (running) void connect();
    }
  })();
}

setInterval(() => { if (!running && token()) startDiscordGateway(); }, 15_000).unref?.();
