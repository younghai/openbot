import { EventEmitter } from "node:events";

export type ClientEvent = Record<string, unknown> & { type: string };

type Sender = (event: ClientEvent) => void;

const bus = new EventEmitter();
const senders = new Set<Sender>();

export function addSender(send: Sender): void {
  senders.add(send);
}

export function removeSender(send: Sender): void {
  senders.delete(send);
}

/** Fire-and-forget broadcast to every connected client (WS). Envelope carries a schema version. */
export function broadcast(event: ClientEvent): void {
  const envelope = { v: 1, ...event };
  for (const send of senders) {
    try {
      send(envelope);
    } catch {
      removeSender(send);
    }
  }
  bus.emit("event", envelope);
}

export function onEvent(listener: (event: ClientEvent) => void): void {
  bus.on("event", listener);
}
