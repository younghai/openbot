import { db, uid, now } from "./db.js";
import { broadcast } from "./events.js";

/** In-app notification center: approval waits, task completions, routine results. */
export interface NotificationRow {
  id: string;
  kind: string; // approval | task | routine | system
  title: string;
  body: string | null;
  created_at: number;
  read_at: number | null;
}

export function notify(kind: NotificationRow["kind"], title: string, body = ""): NotificationRow {
  const id = uid();
  db.prepare("INSERT INTO notifications (id, kind, title, body, created_at) VALUES (?,?,?,?,?)").run(id, kind, title.slice(0, 300), body.slice(0, 1000), now());
  const row = db.prepare("SELECT * FROM notifications WHERE id=?").get(id) as unknown as NotificationRow;
  broadcast({ type: "notification.new", notification: row });
  return row;
}

export function listNotifications(unreadOnly: boolean, limit = 50): NotificationRow[] {
  return (unreadOnly
    ? db.prepare("SELECT * FROM notifications WHERE read_at IS NULL ORDER BY created_at DESC LIMIT ?").all(limit)
    : db.prepare("SELECT * FROM notifications ORDER BY created_at DESC LIMIT ?").all(limit)) as unknown as NotificationRow[];
}

export function markAllRead(): number {
  const r = db.prepare("UPDATE notifications SET read_at=? WHERE read_at IS NULL").run(now());
  return Number(r.changes);
}
