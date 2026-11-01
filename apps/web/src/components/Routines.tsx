import React, { useState } from "react";
import { api } from "../api";
import type { Bootstrap } from "../types";

export function Routines({ boot, refresh }: { boot: Bootstrap; refresh: () => void }): JSX.Element {
  const [botId, setBotId] = useState(boot.bots[0]?.id ?? "");
  const [name, setName] = useState("");
  const [cron, setCron] = useState("0 9 * * *");
  const [prompt, setPrompt] = useState("");

  return (
    <div className="page">
      <h2>루틴</h2>
      <p className="muted">cron 스케줄에 따라 봇이 스스로 대화를 시작합니다. 실패 10회 연속 시 자동 비활성화됩니다.</p>

      <div className="card">
        <div className="form-grid">
          <label>봇</label>
          <select value={botId} onChange={(e) => setBotId(e.target.value)}>
            {boot.bots.map((b) => (
              <option key={b.id} value={b.id}>
                {b.emoji} {b.name}
              </option>
            ))}
          </select>
          <label>이름</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="아침 브리핑" />
          <label>cron (분 시 일 월 요일)</label>
          <input value={cron} onChange={(e) => setCron(e.target.value)} placeholder="*/5 * * * * 또는 0 9 * * *" />
          <label>프롬프트</label>
          <textarea rows={3} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="오늘 할 일 정리해서 알려줘" />
        </div>
        <button
          className="btn primary"
          disabled={!botId || !cron.trim() || !prompt.trim()}
          onClick={async () => {
            await api.createRoutine({ botId, cron, prompt, name: name || cron });
            setName("");
            setPrompt("");
            refresh();
          }}
        >
          루틴 추가
        </button>
      </div>

      {boot.routines.length === 0 && <p className="muted">루틴이 없습니다.</p>}
      {boot.routines.map((r) => {
        const bot = boot.bots.find((b) => b.id === r.bot_id);
        return (
          <div key={r.id} className="card row">
            <div>
              <strong>
                {bot?.emoji} {r.name}
              </strong>{" "}
              <code>{r.cron}</code>{" "}
              <span className={`badge ${r.enabled ? "ok" : "off"}`}>{r.enabled ? "켜짐" : "꺼짐"}</span>
              {r.failure_count > 0 && <span className="badge warn">실패 {r.failure_count}</span>}
              <div className="muted small">
                {bot?.name} · 마지막 실행: {r.last_run_at ? new Date(r.last_run_at).toLocaleString("ko-KR") : "없음"}
              </div>
              <div className="small">{r.prompt}</div>
            </div>
            <div className="row">
              <button className="btn" onClick={async () => { await api.patchRoutine(r.id, { enabled: !r.enabled }); refresh(); }}>
                {r.enabled ? "끄기" : "켜기"}
              </button>
              <button className="btn danger" onClick={async () => { await api.deleteRoutine(r.id); refresh(); }}>
                삭제
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
