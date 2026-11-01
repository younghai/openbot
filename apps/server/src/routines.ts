import { db, now, type RoutineRow } from "./db.js";
import { cronMatches } from "./cron.js";
import { getOrCreateDmConversation, insertMessage } from "./agent/loop.js";
import { enqueueJob } from "./queue.js";

/**
 * Scan every 15s. A routine fires when the current minute matches its cron and the
 * routine has not already fired in this minute (checked via last_run_at).
 */
export function startRoutineScheduler(): void {
  setInterval(() => {
    const routines = db.prepare("SELECT * FROM routines WHERE enabled=1").all() as unknown as RoutineRow[];
    const nowMs = now();
    const nowDate = new Date(nowMs);
    const minuteKey = `${nowDate.getFullYear()}-${nowDate.getMonth()}-${nowDate.getDate()}-${nowDate.getHours()}-${nowDate.getMinutes()}`;
    for (const routine of routines) {
      try {
        if (!cronMatches(routine.cron, nowDate)) continue;
        if (routine.last_run_at) {
          const last = new Date(routine.last_run_at);
          const lastKey = `${last.getFullYear()}-${last.getMonth()}-${last.getDate()}-${last.getHours()}-${last.getMinutes()}`;
          if (lastKey === minuteKey) continue;
        }
        db.prepare("UPDATE routines SET last_run_at=? WHERE id=?").run(nowMs, routine.id);
        // spread routines firing in the same minute (0–30s, stable per routine)
        const jitterMs = (parseInt(routine.id.replace(/[^0-9]/g, "").slice(-6) || "0", 10) % 30) * 1000;
        setTimeout(() => {
          try {
            const conv = getOrCreateDmConversation(routine.bot_id);
            insertMessage(conv.id, routine.bot_id, "user", `[routine: ${routine.name}] ${routine.prompt}`, {
              meta: { source: "routine", routineId: routine.id },
            });
            enqueueJob(routine.bot_id, conv.id, routine.prompt, "routine");
          } catch {
            db.prepare("UPDATE routines SET enabled=0, failure_count=failure_count+1 WHERE id=?").run(routine.id);
          }
        }, jitterMs);
      } catch {
        db.prepare("UPDATE routines SET enabled=0, failure_count=failure_count+1 WHERE id=?").run(routine.id);
      }
    }
  }, 15_000);
}
