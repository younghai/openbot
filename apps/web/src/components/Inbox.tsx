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
  const [allows, setAllows] = useState<{ scope: string; conversation_id: string; bot_id: string; tool: string; created_at: number }[]>([]);
  const [secretInput, setSecretInput] = useState<Record<string, string>>({});

  const load = () => {
    api.approvals().then(setRows).catch((e) => setErr(String(e.message ?? e)));
    api.policyPresets().then((p) => { setPresets(p.presets); setCurrentPreset(p.current); }).catch(() => undefined);
    api.approvalAllows().then(setAllows).catch(() => undefined);
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

  const decide = async (id: string, kind: "approve" | "deny", scope?: "conversation" | "always") => {
    try {
      const r = kind === "approve" ? await api.approveTool(id, scope) : await api.denyTool(id);
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
      {pending.map((r) => {
        const isHelp = r.tool === "computer.request_help";
        const isSecret = r.tool === "computer.request_secret";
        const args = (() => { try { return JSON.parse(r.args ?? "{}") as Record<string, unknown>; } catch { return {}; } })();
        return (
        <div key={r.id} className="card row approval-card">
          <div style={{ flex: 1 }}>
            <strong>{isHelp ? "🙋 사람 필요" : isSecret ? "🔑 기밀 입력" : r.tool}</strong> <span className="badge warn">승인 대기</span>
            <div className="muted small">{botName(r.bot_id)} · {new Date(r.created_at).toLocaleTimeString()}</div>
            {isHelp && <div className="small" style={{ margin: "6px 0" }}>🤖 {String(args.reason ?? "")} {args.url ? <a className="muted" href={String(args.url)} target="_blank" rel="noreferrer">{String(args.url)}</a> : null}</div>}
            {isHelp && <div className="muted small">승인하면 채팅 화면의 🖥️ 라이브 패널에서 그 단계를 직접 수행하고 <b>반납</b>하세요. 봇이 이어서 진행합니다.</div>}
            {!isHelp && !isSecret && <pre className="approval-args">{r.args}</pre>}
          </div>
          <div className="row" style={{ flexWrap: "wrap", justifyContent: "flex-end", gap: 6 }}>
            {isHelp && <>
              <button className="btn primary" onClick={() => decide(r.id, "approve")}>🙋 내가 직접 수행</button>
              <button className="btn danger" onClick={() => decide(r.id, "deny")}>할 수 없음</button>
            </>}
            {isSecret && <>
              <input
                type="password"
                placeholder={String(args.label ?? "기밀 값")}
                autoComplete="off"
                value={secretInput[r.id] ?? ""}
                onChange={(e) => setSecretInput((m) => ({ ...m, [r.id]: e.target.value }))}
                style={{ width: 200 }}
              />
              <button className="btn primary" disabled={!secretInput[r.id]} onClick={async () => {
                const res = await fetch("/api/browser/secret", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ approvalId: r.id, secret: secretInput[r.id] }) });
                if (!res.ok) setErr("기밀 주입 실패");
                setSecretInput((m) => { const n = { ...m }; delete n[r.id]; return n; });
                load();
              }}>입력·주입</button>
              <button className="btn danger" onClick={() => decide(r.id, "deny")}>거부</button>
            </>}
            {!isHelp && !isSecret && <>
              <button className="btn primary" onClick={() => decide(r.id, "approve")}>이번만 허용</button>
              <button className="btn" title="같은 대화·같은 봇·같은 도구는 더 묻지 않음" onClick={() => decide(r.id, "approve", "conversation")}>이 대화에서 허용</button>
              <button className="btn" title="이 봇의 이 도구는 어디서든 더 묻지 않음 (아래 규칙 목록에 저장)" onClick={() => decide(r.id, "approve", "always")}>이 봇에서 항상</button>
              <button className="btn danger" onClick={() => decide(r.id, "deny")}>거부</button>
            </>}
          </div>
        </div>
        );
      })}
      {allows.length > 0 && (
        <>
          <h3>저장된 허용 규칙</h3>
          <p className="muted small">스코프 승인으로 저장된 규칙입니다. 잠금 프리셋에서는 무시됩니다.</p>
          {allows.map((a) => (
            <div key={`${a.scope}:${a.conversation_id}:${a.bot_id}:${a.tool}`} className="card row">
              <div className="small">
                <code>{a.tool}</code> · {botName(a.bot_id)}{" "}
                <span className={`badge ${a.scope === "bot" ? "ok" : ""}`}>{a.scope === "bot" ? "이 봇에서 항상" : "이 대화에서"}</span>
              </div>
              <button className="btn small danger" onClick={async () => { await api.removeApprovalAllow(a.scope, a.conversation_id, a.bot_id, a.tool).catch(() => undefined); load(); }}>제거</button>
            </div>
          ))}
        </>
      )}
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
