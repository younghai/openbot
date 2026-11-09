import React, { useEffect, useState } from "react";
import { api } from "../api";
import type { Stats } from "../types";

/** 플릿 대시보드: 봇별 활동·도구 호출·토큰·루틴 상태 + 전체 요약. */
export function Dashboard(): JSX.Element {
  const [stats, setStats] = useState<Stats | null>(null);
  const [backupNote, setBackupNote] = useState("");
  const [channels, setChannels] = useState<Record<string, boolean>>({});

  useEffect(() => {
    api.stats().then(setStats).catch(() => setStats(null));
    api.channelStatus().then(setChannels).catch(() => setChannels({}));
  }, []);

  if (!stats) return <div className="page muted">통계를 불러오는 중…</div>;

  const t = stats.totals;
  const fmt = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  const maxMsgs = Math.max(1, ...stats.bots.map((b) => b.messages));

  return (
    <div className="page">
      <h2>대시보드</h2>
      <div className="grid3" style={{ gap: 10 }}>
        <div className="card stat"><div className="stat-n">{fmt(t.messages)}</div><div className="muted small">메시지</div></div>
        <div className="card stat"><div className="stat-n">{fmt(t.toolCalls)}</div><div className="muted small">도구 호출</div></div>
        <div className="card stat"><div className="stat-n">{fmt(t.tokensIn + t.tokensOut)}</div><div className="muted small">토큰 (in+out)</div></div>
        <div className="card stat"><div className="stat-n">{t.jobs24h}</div><div className="muted small">24시간 잡</div></div>
        <div className="card stat"><div className="stat-n" style={t.pendingApprovals > 0 ? { color: "var(--warn, #fbbf24)" } : undefined}>{t.pendingApprovals}</div><div className="muted small">승인 대기</div></div>
        <div className="card stat">
          <div className="stat-n">{Object.values(t.tasks).reduce((s, n) => s + n, 0)}</div>
          <div className="muted small">작업 {["backlog", "doing", "review", "done"].filter((k) => t.tasks[k]).map((k) => `${k}:${t.tasks[k]}`).join(" ")}</div>
        </div>
      </div>

      <h3>봇별 활동</h3>
      <table>
        <thead>
          <tr><th>봇</th><th>메시지</th><th>도구 호출</th><th>24h 잡 (에러)</th><th>루틴 (실패)</th><th>활동 비중</th></tr>
        </thead>
        <tbody>
          {stats.bots.map((b) => (
            <tr key={b.id}>
              <td>{b.emoji} {b.name} {b.status === "paused" && <span className="badge warn">일시정지</span>}</td>
              <td>{b.messages}</td>
              <td>{b.toolCalls}</td>
              <td>{b.jobs24h} {b.jobsError24h > 0 && <span className="badge bad">{b.jobsError24h}</span>}</td>
              <td>{b.routines} {b.routineFailures > 0 && <span className="badge warn">실패 {b.routineFailures}</span>}</td>
              <td style={{ width: 160 }}>
                <div className="bar-track small"><div className="bar-openbot" style={{ width: `${(b.messages / maxMsgs) * 100}%` }} /></div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>채널 상태</h3>
      <div className="grid3" style={{ gap: 10 }}>
        {[["Telegram", channels.telegram], ["Discord", channels.discord], ["Slack", channels.slack], ["이메일", channels.email], ["전화·SMS", channels.phone], ["결제", channels.payment]].map(([name, on]) => (
          <div key={String(name)} className="card stat" style={{ padding: "10px 14px" }}>
            <span style={{ fontSize: 18 }}>{on ? "🟢" : "⚪"}</span> <span className="small">{name}</span>
            <span className={`badge ${on ? "ok" : ""}`}>{on ? "연결됨" : "미설정"}</span>
          </div>
        ))}
      </div>

      <h3>데이터 백업</h3>
      <div className="card row">
        <div className="muted small" style={{ flex: 1 }}>
          전체 데이터(SQLite)를 한 파일로 백업합니다. data/backups/에 최근 10개를 유지합니다.
        </div>
        <button className="btn primary" onClick={async () => {
          const r = await api.backup().catch((e) => null);
          setBackupNote(r ? `백업 완료: ${r.file} (${Math.round(r.bytes / 1024)}KB)` : "백업 실패");
        }}>지금 백업</button>
      </div>
      {backupNote && <p className="small feedback">{backupNote}</p>}
    </div>
  );
}
