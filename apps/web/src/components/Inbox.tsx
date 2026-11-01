import React, { useEffect, useState } from "react";
import { api } from "../api";
import { subscribe } from "../ws";
import type { Approval, Bootstrap, PolicyPreset } from "../types";

/** 승인 Inbox: 'ask' 정책 도구가 실행 전 대기하는 곳. 정책 프리셋으로 승인 피로를 조절한다. */
export function Inbox({ boot }: { boot: Bootstrap }): JSX.Element {
  const [rows, setRows] = useState<Approval[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [presets, setPresets] = useState<PolicyPreset[]>([]);
  const [currentPreset, setCurrentPreset] = useState<string>("");

  const load = () => {
    api.approvals().then(setRows).catch((e) => setErr(String(e.message ?? e)));
    api.policyPresets().then((p) => { setPresets(p.presets); setCurrentPreset(p.current); }).catch(() => undefined);
  };

  useEffect(() => {
    load();
    return subscribe((event) => {
      if (event.type === "approval.requested" || event.type === "approval.decided") load();
    });
  }, []);

  const botName = (id: string | null) => boot.bots.find((b) => b.id === id)?.name ?? "(bot)";
  const pending = rows.filter((r) => r.status === "pending");
  const decided = rows.filter((r) => r.status !== "pending").slice(0, 20);

  const decide = async (id: string, kind: "approve" | "deny") => {
    try {
      const r = kind === "approve" ? await api.approveTool(id) : await api.denyTool(id);
      if (!r.ok && r.error) setErr(r.error);
    } catch (e) {
      setErr(String(e instanceof Error ? e.message : e));
    }
    load();
  };

  return (
    <div className="page">
      <h2>승인 Inbox</h2>
      <p className="muted">
        부작용 도구(터미널 실행, 파일 쓰기, 브라우저 조작 등)는 실행 전 여기서 승인을 기다립니다. 10분 무응답 시 자동 거부됩니다.
      </p>
      {err && <p className="test-result">{err}</p>}
      <div className="card">
        <h3 style={{ marginTop: 0 }}>정책 프리셋</h3>
        <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
          {presets.map((p) => (
            <button
              key={p.id}
              className={`btn ${currentPreset === p.id ? "primary" : ""}`}
              title={p.description}
              onClick={async () => {
                const r = await api.applyPolicyPreset(p.id).catch((e) => ({ ok: false, error: String(e.message ?? e) }));
                if (!r.ok) setErr(r.error ?? "적용 실패");
                load();
              }}
            >
              {p.name}{currentPreset === p.id ? " ✓" : ""}
            </button>
          ))}
          {currentPreset === "custom" && <span className="badge warn">사용자 정의</span>}
        </div>
        <p className="muted small" style={{ marginBottom: 0 }}>
          {presets.find((p) => p.id === currentPreset)?.description ?? "정책 테이블이 프리셋과 다르게 수동 수정되었습니다."}
        </p>
      </div>
      {pending.length === 0 && <div className="card muted">대기 중인 승인 요청이 없습니다.</div>}
      {pending.map((r) => (
        <div key={r.id} className="card row approval-card">
          <div>
            <strong>{r.tool}</strong> <span className="badge warn">승인 대기</span>
            <div className="muted small">{botName(r.bot_id)} · {new Date(r.created_at).toLocaleTimeString()}</div>
            <pre className="approval-args">{r.args}</pre>
          </div>
          <div className="row">
            <button className="btn primary" onClick={() => decide(r.id, "approve")}>승인</button>
            <button className="btn danger" onClick={() => decide(r.id, "deny")}>거부</button>
          </div>
        </div>
      ))}
      {decided.length > 0 && (
        <>
          <h3>최근 결정</h3>
          {decided.map((r) => (
            <div key={r.id} className="card row">
              <div>
                <code>{r.tool}</code>{" "}
                <span className={`badge ${r.status === "approved" ? "ok" : "off"}`}>
                  {r.status === "approved" ? "승인됨" : r.status === "denied" ? "거부됨" : "만료"}
                </span>
                <div className="muted small">{botName(r.bot_id)} · {r.args?.slice(0, 120)}</div>
              </div>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
