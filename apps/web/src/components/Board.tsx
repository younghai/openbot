import React, { useEffect, useState } from "react";
import { api } from "../api";
import { subscribe } from "../ws";
import type { Bootstrap, Task } from "../types";

const COLUMNS: { key: Task["status"]; label: string }[] = [
  { key: "backlog", label: "백로그" },
  { key: "doing", label: "진행 중" },
  { key: "review", label: "검토" },
  { key: "done", label: "완료" },
];
const ORDER: Task["status"][] = ["backlog", "doing", "review", "done"];

/** 작업 보드: 봇이 담당자인 칸반. "실행"은 작업을 담당 봇의 큐로 넘기고, 봇이 task.update로 상태를 보고한다. */
export function Board({ boot, refresh, onOpenChat }: { boot: Bootstrap; refresh: () => void; onOpenChat: (id: string) => void }): JSX.Element {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [title, setTitle] = useState("");
  const [assignee, setAssignee] = useState("");
  const [due, setDue] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  const load = () => api.tasks().then(setTasks).catch(() => undefined);

  useEffect(() => {
    load();
    return subscribe((e) => {
      if (e.type === "task.updated") load();
    });
  }, []);

  const add = async (): Promise<void> => {
    if (!title.trim()) return;
    setBusy(true);
    try {
      await api.createTask({
        title: title.trim(),
        assigneeBotId: assignee || undefined,
        dueAt: due ? new Date(due + "T23:59:59").getTime() : undefined,
      });
      setTitle("");
      setDue("");
      setNote("");
      load();
    } catch (e) {
      setNote(`생성 실패: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const move = async (t: Task, dir: -1 | 1): Promise<void> => {
    const idx = ORDER.indexOf(t.status);
    const next = ORDER[Math.min(Math.max(idx + dir, 0), ORDER.length - 1)];
    if (next === t.status) return;
    await api.patchTask(t.id, { status: next }).catch(() => undefined);
    load();
  };

  const run = async (t: Task): Promise<void> => {
    setNote(`'${t.title}' 실행 지시 → ${t.assignee?.name ?? "?"}`);
    const r = await api.runTask(t.id).catch((e) => null);
    if (r) onOpenChat(r.conversationId);
    load();
  };

  return (
    <div className="page">
      <h2>작업 보드</h2>
      <p className="muted">봇이 담당자입니다. "실행"을 누르면 담당 봇이 작업을 수행하고 <code>task.update</code> 도구로 스스로 상태를 보고합니다.</p>

      <div className="card">
        <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
          <input style={{ flex: "1 1 240px" }} placeholder="작업 제목 — 예: 이번 주 뉴스 브리핑 정리" value={title} onChange={(e) => setTitle(e.target.value)} />
          <select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
            <option value="">담당 봇: 미지정</option>
            {boot.bots.map((b) => (
              <option key={b.id} value={b.id}>{b.emoji} {b.name}</option>
            ))}
          </select>
          <input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
          <button className="btn primary" disabled={!title.trim() || busy} onClick={add}>추가</button>
        </div>
        {note && <p className="small feedback">{note}</p>}
      </div>

      <div className="board">
        {COLUMNS.map((col) => {
          const items = tasks.filter((t) => t.status === col.key);
          return (
            <div key={col.key} className="board-col">
              <div className="board-col-head">
                {col.label} <span className="muted small">{items.length}</span>
              </div>
              {items.map((t) => (
                <div key={t.id} className={`task-card ${t.status}`}>
                  <div className="task-title">{t.title}</div>
                  <div className="muted small">
                    {t.assignee ? `${t.assignee.emoji} ${t.assignee.name}` : "미지정"}
                    {t.due_at ? ` · ${new Date(t.due_at).toLocaleDateString()}` : ""}
                  </div>
                  {t.activity.length > 0 && (
                    <div className="muted small task-last">{t.activity[t.activity.length - 1].by}: {t.activity[t.activity.length - 1].text.slice(0, 60)}</div>
                  )}
                  <div className="row task-actions">
                    <button className="btn small" title="이전 상태로" onClick={() => void move(t, -1)}>←</button>
                    <button className="btn small" title="다음 상태로" onClick={() => void move(t, 1)}>→</button>
                    {t.assignee && t.status !== "done" && (
                      <button className="btn small primary" onClick={() => void run(t)}>▶ 실행</button>
                    )}
                    {t.conversation_id && <button className="btn small" onClick={() => onOpenChat(t.conversation_id!)}>대화</button>}
                    <button className="btn small danger" onClick={async () => { await api.deleteTask(t.id); load(); }}>✕</button>
                  </div>
                </div>
              ))}
              {items.length === 0 && <div className="muted small board-empty">없음</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
