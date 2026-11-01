import React, { useEffect, useState } from "react";
import { api } from "../api";
import type { AuditRow, Bootstrap } from "../types";

export function AuditLog({ boot }: { boot: Bootstrap }): JSX.Element {
  const [rows, setRows] = useState<AuditRow[]>([]);
  useEffect(() => {
    api.audit(200).then(setRows).catch(() => undefined);
    const t = setInterval(() => api.audit(200).then(setRows).catch(() => undefined), 5000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="page">
      <h2>감사 로그</h2>
      <p className="muted">모든 도구 실행은 정책 판정(허용/차단/오류)과 함께 기록됩니다. 5초마다 자동 새로고침.</p>
      <table className="table">
        <thead>
          <tr>
            <th>시각</th>
            <th>봇</th>
            <th>도구</th>
            <th>판정</th>
            <th>상세</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{new Date(r.created_at).toLocaleTimeString("ko-KR")}</td>
              <td>{boot.bots.find((b) => b.id === r.bot_id)?.name ?? "—"}</td>
              <td>
                <code>{r.tool}</code>
                <details>
                  <summary className="muted small">인자</summary>
                  <pre className="tool-body">{(() => { try { return JSON.stringify(JSON.parse(r.args ?? ""), null, 2); } catch { return r.args; } })()}</pre>
                </details>
              </td>
              <td>
                <span className={`badge ${r.decision === "allow" ? "ok" : r.decision === "deny" ? "off" : "warn"}`}>{r.decision}</span>
              </td>
              <td className="muted small">{r.detail}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <p className="muted">기록 없음</p>}
    </div>
  );
}
