import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import { addSender, removeSender } from "./events.js";
import { enqueueFromHttp } from "./chat.js";
import { db } from "./db.js";
import { wsTokenOk } from "./auth.js";

export function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
  if (req.url === undefined || !req.url.startsWith("/ws") || !wsTokenOk(req.url)) {
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
    if (msg.type === "browser.watch") {
      // 라이브 브라우저 패널: 이 커넥션을 프레임 구독자로 등록 (CK live screen 패턴)
      const botId = String(msg.botId ?? "");
      if (!botId) return send({ type: "error", error: "botId required" });
      let computerId = String(msg.computerId ?? "");
      if (!computerId) {
        const bot = db.prepare("SELECT computer_id FROM bots WHERE id=?").get(botId) as { computer_id: string | null } | undefined;
        computerId = bot?.computer_id ?? ((db.prepare("SELECT id FROM computers WHERE name='Team Computer' AND kind='team' LIMIT 1").get() as { id: string } | undefined)?.id ?? "");
      }
      watchFrames(ws, send, computerId, botId);
      return;
    }
    if (msg.type === "browser.unwatch") {
      unwatchFrames(ws);
      return;
    }
    if (msg.type === "browser.act") {
      // 제어권 이관 중인 사람의 직접 조작 (좌표는 1280x800 뷰포트 기준)
      void import("./tools/browser.js").then(async (b) => {
        const { takeoverIsActive } = await import("./tools/takeover.js");
        const computerId = String(msg.computerId ?? "");
        const botId = String(msg.botId ?? "");
        if (!takeoverIsActive(computerId, botId)) {
          return send({ type: "browser.act.result", ok: false, error: "제어권이 봇에 있습니다 — 컴퓨터.request_help 승인 후 조작할 수 있습니다" });
        }
        const r = await b.proxyAction(computerId, botId, (msg.action ?? {}) as never);
        send({ type: "browser.act.result", ...r });
      });
      return;
    }
    send({ type: "error", error: `unknown message type '${String(msg.type)}'` });
  });
  ws.on("close", () => {
    removeSender(send);
    unwatchFrames(ws);
  });
});

// ---------------------------------------------------------------- 라이브 프레임 펌프

interface FrameWatcher {
  ws: WebSocket;
  send: (e: Record<string, unknown>) => void;
  computerId: string;
  botId: string;
}
const frameWatchers = new Set<FrameWatcher>();
let framePump: ReturnType<typeof setInterval> | null = null;

function watchFrames(ws: WebSocket, send: (e: Record<string, unknown>) => void, computerId: string, botId: string): void {
  unwatchFrames(ws); // 한 커넥션은 한 패널만
  frameWatchers.add({ ws, send, computerId, botId });
  send({ type: "browser.watching", computerId, botId });
  if (!framePump) framePump = setInterval(pumpFrames, 800);
}

function unwatchFrames(ws: WebSocket): void {
  for (const w of frameWatchers) if (w.ws === ws) frameWatchers.delete(w);
  if (frameWatchers.size === 0 && framePump) {
    clearInterval(framePump);
    framePump = null;
  }
}

async function pumpFrames(): Promise<void> {
  if (frameWatchers.size === 0) return;
  const b = await import("./tools/browser.js");
  // 같은 세션은 한 번만 캡처해 모든 구독자에 배포
  const bySession = new Map<string, FrameWatcher[]>();
  for (const w of frameWatchers) {
    const k = `${w.computerId}:${w.botId}`;
    bySession.set(k, [...(bySession.get(k) ?? []), w]);
  }
  for (const [k, ws] of bySession) {
    const [computerId, botId] = k.split(":");
    const frame = await b.frameJpeg(computerId, botId).catch(() => null);
    if (!frame) continue;
    const dataUrl = `data:image/jpeg;base64,${frame.toString("base64")}`;
    for (const w of ws) if (w.ws.readyState === WebSocket.OPEN) w.send({ type: "browser.frame", computerId, botId, frame: dataUrl });
  }
}
