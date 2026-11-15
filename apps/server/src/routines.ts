import { db, now, type RoutineRow } from "./db.js";
import { cronMatches } from "./cron.js";
import { getOrCreateDmConversation, insertMessage } from "./agent/loop.js";
import { enqueueJob } from "./queue.js";
import { broadcast } from "./events.js";

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
            // Does(보고만/check-in) + Until(목표) — CopilotKit 4부 루틴 구조
            const mode = (routine as { mode?: string }).mode ?? "act";
            const goal = (routine as { goal?: string | null }).goal ?? null;
            const preamble = [
              mode === "report" ? "이번 루틴 실행은 '보고만' 모드다: 상태를 확인하고 요약 보고만 한다. 파일 쓰기·전송·실행 도구는 사용하지 않는다." : null,
              goal ? `이 루틴의 목표: "${goal}". 이번 실행의 결과를 보고할 때 마지막 줄에 정확히 'GOAL_REACHED: yes' 또는 'GOAL_REACHED: no'를 붙인다(판단 근거 한 문장 포함).` : null,
            ].filter(Boolean).join("\n");
            const fullPrompt = preamble ? `${preamble}\n\n${routine.prompt}` : routine.prompt;
            insertMessage(conv.id, routine.bot_id, "user", `[routine: ${routine.name}] ${routine.prompt}`, {
              meta: { source: "routine", routineId: routine.id },
            });
            enqueueJob(routine.bot_id, conv.id, fullPrompt, "routine", routine.id);
            if (goal) {
              // 목표 달성 감시: 잡 완료 후 어시스턴트 마지막 답변에서 GOAL_REACHED: yes 찾기 (지연 폴링)
              const checkGoal = async (tries: number): Promise<void> => {
                if (tries > 30) return;
                const job = db.prepare("SELECT status FROM queue_jobs WHERE conversation_id=? ORDER BY created_at DESC LIMIT 1").get(conv.id) as { status: string } | undefined;
                if (job && (job.status === "done" || job.status === "error")) {
                  const last = db.prepare("SELECT content FROM messages WHERE conversation_id=? AND role='assistant' ORDER BY created_at DESC LIMIT 1").get(conv.id) as { content: string } | undefined;
                  if (/GOAL_REACHED:\s*yes/i.test(String(last?.content ?? ""))) {
                    db.prepare("UPDATE routines SET enabled=0 WHERE id=?").run(routine.id);
                    insertMessage(conv.id, null, "system", `🎯 루틴 '${routine.name}'의 목표가 달성되어 자동으로 중지되었습니다.`, { meta: { source: "routine-goal", routineId: routine.id } });
                    broadcast({ type: "routine.completed", routineId: routine.id, name: routine.name });
                    return;
                  }
                  return; // done이지만 미달성 — 다음 스케줄에 재시도
                }
                setTimeout(() => void checkGoal(tries + 1), 4000);
              };
              setTimeout(() => void checkGoal(0), 30_000);
            }
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
