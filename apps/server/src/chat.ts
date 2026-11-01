import { db, now } from "./db.js";
import { broadcast } from "./events.js";
import { insertMessage } from "./agent/loop.js";
import { enqueueJob } from "./queue.js";

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
  insertMessage(conversationId, null, "user", content, { meta: { source: "user", ...(attachments?.length ? { attachments } : {}) } });
  broadcast({ type: "chat.message", conversationId, botId: null, role: "user", content });
  const job = enqueueJob(carrierBotId, conversationId, content, "user");
  return job.id;
}
