import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import { addSender, removeSender } from "./events.js";
import { enqueueFromHttp } from "./chat.js";

export function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
  if (req.url !== "/ws") {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
}

const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws: WebSocket) => {
  const send = (event: Record<string, unknown>) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(event));
  addSender(send);
  ws.send(JSON.stringify({ type: "hello", version: "0.1.0" }));
  ws.on("message", async (data) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(String(data)) as Record<string, unknown>;
    } catch {
      send({ type: "error", error: "invalid json" });
      return;
    }
    if (msg.type === "ping") return send({ type: "pong" });
    if (msg.type === "chat.send") {
      try {
        const attachments = Array.isArray(msg.attachments)
          ? (msg.attachments as { path: string; name?: string; contentType?: string }[]).filter((a) => typeof a?.path === "string").slice(0, 4)
          : undefined;
        const res = await enqueueFromHttp(String(msg.conversationId ?? ""), String(msg.content ?? ""), attachments);
        if (typeof res === "string" && res.startsWith("__")) {
          send({ type: "chat.steered", steered: res.replace(/^__|$/g, "").replace(/__/g, ""), conversationId: msg.conversationId });
        } else {
          send({ type: "chat.accepted", jobId: res, conversationId: msg.conversationId });
        }
      } catch (err) {
        send({ type: "chat.error", error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }
    send({ type: "error", error: `unknown message type '${String(msg.type)}'` });
  });
  ws.on("close", () => removeSender(send));
});
