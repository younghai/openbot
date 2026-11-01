import type { ServerEvent } from "./types";

type Listener = (event: ServerEvent) => void;

const listeners = new Set<Listener>();
let socket: WebSocket | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

function connect(): void {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(`${proto}://${location.host}/ws`);
  socket.onmessage = (ev) => {
    try {
      const parsed = JSON.parse(ev.data) as ServerEvent;
      for (const listener of listeners) listener(parsed);
    } catch {
      /* ignore malformed frames */
    }
  };
  socket.onclose = () => {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = setTimeout(connect, 2000);
  };
}

export function subscribe(listener: Listener): () => void {
  if (!socket && !retryTimer) connect();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function sendWs(obj: Record<string, unknown>): void {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(obj));
}

export function wsConnected(): boolean {
  return socket?.readyState === WebSocket.OPEN;
}
