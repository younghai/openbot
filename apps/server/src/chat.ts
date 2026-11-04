import { db, now } from "./db.js";
import { broadcast } from "./events.js";
import { insertMessage } from "./agent/loop.js";
import { enqueueJob, cancelByConversation } from "./queue.js";

export interface ChatAttachment {
  path: string;
  name?: string;
  contentType?: string;
}

/**
 * Shared entry for human messages arriving via REST or WebSocket: persist the user
 * message (with optional attachments), broadcast it, and enqueue the turn as a job
 * (channel turns fan out to every member bot inside the job runner).
 */
export async function enqueueFromHttp(conversationId: string, content: string, attachments?: ChatAttachment[]): Promise<string> {
  const conv = db.prepare("SELECT * FROM conversations WHERE id=?").get(conversationId) as
    | { id: string; kind: string; bot_id: string | null }
    | undefined;
  if (!conv) throw new Error("conversation not found");
  let carrierBotId: string;
  if (conv.kind === "channel") {
    const members = db.prepare("SELECT bot_id FROM channel_members WHERE conversation_id=?").all(conversationId) as { bot_id: string }[];
    if (members.length === 0) throw new Error("channel has no member bots");
    carrierBotId = members[0].bot_id;
  } else {
    if (!conv.bot_id) throw new Error("dm conversation has no bot");
    carrierBotId = conv.bot_id;
  }
  // ---- plain-words steering (deepseek-bot pattern): stop / usage / be quiet ----
  const word = content.trim().toLowerCase().replace(/[.!?~。！？]+$/, "");
  const isKo = (w: string): boolean => ["\uadf8\ub9cc", "\uc911\uc9c0\ud574", "\uc815\uc9c0\ud574"].includes(w);
  if (word === "stop" || isKo(word)) {
    const n = cancelByConversation(conversationId);
    const reply = n > 0 ? `\uc9c4\ud589 \uc911\uc778 \uc791\uc5c5 ${n}\uac74\uc744 \uc911\ub2e8\ud588\uc2b5\ub2c8\ub2e4.` : "\uc9c4\ud589 \uc911\uc778 \uc791\uc5c5\uc774 \uc5c6\uc2b5\ub2c8\ub2e4.";
    insertMessage(conversationId, null, "assistant", reply, { meta: { source: "steering" } });
    broadcast({ type: "chat.message", conversationId, botId: null, role: "assistant", content: reply });
    return "__steered_stop__";
  }
  if (word === "usage" || word === "\uc0ac\uc6a9\ub7c9") {
    const rows = db.prepare("SELECT meta FROM messages WHERE conversation_id=? AND role='assistant' AND meta LIKE '%usage%'").all(conversationId) as { meta: string }[];
    let tin = 0, tout = 0;
    for (const r of rows) {
      try {
        const u = (JSON.parse(r.meta) as { usage?: { inputTokens?: number; outputTokens?: number } }).usage;
        tin += u?.inputTokens ?? 0; tout += u?.outputTokens ?? 0;
      } catch { /* skip */ }
    }
    const reply = `\uc774 \ub300\ud654 \ud1a0\ud070: \uc785\ub825 ${tin.toLocaleString()} / \ucd9c\ub825 ${tout.toLocaleString()} (\ud569 ${ (tin + tout).toLocaleString() })`;
    insertMessage(conversationId, null, "assistant", reply, { meta: { source: "steering" } });
    broadcast({ type: "chat.message", conversationId, botId: null, role: "assistant", content: reply });
    return "__steered_usage__";
  }
  if (word === "be quiet" || word === "\uc870\uc6a9\ud788 \ud574" || word === "\uc870\uc6a9\ud788") {
    db.prepare("UPDATE conversations SET muted=1 WHERE id=?").run(conversationId);
    const reply = "\ud6a1";
    insertMessage(conversationId, null, "assistant", reply, { meta: { source: "steering" } });
    broadcast({ type: "chat.message", conversationId, botId: null, role: "assistant", content: reply });
    return "__steered_mute__";
  }
  if (word === "unmute" || word === "\ub9d0\ud574\uc918" || word === "\ub9d0\ud574\uc918\ub77c") {
    db.prepare("UPDATE conversations SET muted=0 WHERE id=?").run(conversationId);
    const reply = "\ub2e4\uc2dc \ub4ed\uae30 \uc2dc\uc791\ud569\ub2c8\ub2e4.";
    insertMessage(conversationId, null, "assistant", reply, { meta: { source: "steering" } });
    broadcast({ type: "chat.message", conversationId, botId: null, role: "assistant", content: reply });
    return "__steered_unmute__";
  }
  const muted = (db.prepare("SELECT muted FROM conversations WHERE id=?").get(conversationId) as { muted: number } | undefined)?.muted === 1;
  if (muted) {
    insertMessage(conversationId, null, "user", content, { meta: { source: "user", muted: true } });
    return "__muted__";
  }
  insertMessage(conversationId, null, "user", content, { meta: { source: "user", ...(attachments?.length ? { attachments } : {}) } });
  broadcast({ type: "chat.message", conversationId, botId: null, role: "user", content });
  const job = enqueueJob(carrierBotId, conversationId, content, "user");
  return job.id;
}
