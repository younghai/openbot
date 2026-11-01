import React, { useEffect, useState } from "react";
import { api } from "../api";
import type { Bootstrap, CatalogEntry } from "../types";

export function ToolSources({ boot, refresh }: { boot: Bootstrap; refresh: () => void }): JSX.Element {
  const [kind, setKind] = useState<"mcp" | "openapi" | "composio" | "pipedream" | "treg">("mcp");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [specUrl, setSpecUrl] = useState("");
  const [spec, setSpec] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [feedback, setFeedback] = useState<string>("");
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [catalogId, setCatalogId] = useState("");
  const [catalogBusy, setCatalogBusy] = useState(false);

  useEffect(() => {
    api.toolCatalog().then(setCatalog).catch(() => setCatalog([]));
  }, []);

  const selected = catalog.find((e) => e.id === catalogId);

  const addFromCatalog = async (): Promise<void> => {
    if (!selected) return;
    setCatalogBusy(true);
    try {
      const cfg: Record<string, unknown> = { name: selected.name, kind: "mcp", transport: selected.transport };
      if (selected.url) cfg.url = selected.url;
      if (selected.command) cfg.command = selected.command;
      if (selected.args) cfg.args = selected.args;
      if (selected.env) cfg.env = selected.env;
      const r = await api.createToolSource(cfg);
      setFeedback(
        r.status === "ok"
          ? `${selected.name} 연결됨: ${r.detail ?? ""}${r.tools.length ? " 도구: " + r.tools.slice(0, 5).join(", ") : ""}`
          : `${selected.name} 연결 실패: ${r.detail ?? ""}`
      );
      setCatalogId("");
      refresh();
    } catch (e) {
      setFeedback(`실패: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setCatalogBusy(false);
    }
  };

  return (
    <div className="page">
      <h2>툴 소스</h2>
      <p className="muted">
        원격 MCP 서버, OpenAPI 스펙, Composio, Pipedream Connect, Treg를 연결하면 그 도구들이 모든 봇에게 노출됩니다
        (예: <code>mcp.github.create_issue</code>).
      </p>

      <div className="card">
        <h3>카탈로그에서 추가</h3>
        <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
          <select value={catalogId} onChange={(e) => setCatalogId(e.target.value)}>
            <option value="">프리셋 선택…</option>
            {catalog.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name} ({e.transport}) · {e.requires}
              </option>
            ))}
          </select>
          <button className="btn primary" disabled={!selected || catalogBusy} onClick={addFromCatalog}>
            {catalogBusy ? "연결 중…" : "추가"}
          </button>
        </div>
        {selected && (
          <p className="muted small">
            {selected.description} {selected.transport === "stdio" && <span className="badge">stdio · npx 로컬 실행</span>}
          </p>
        )}
      </div>

      <div className="card">
        <div className="form-grid">
          <label>종류</label>
          <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
            <option value="mcp">MCP (streamable HTTP)</option>
            <option value="openapi">OpenAPI 스펙</option>
            <option value="composio">Composio</option>
            <option value="pipedream">Pipedream Connect</option>
            <option value="treg">Treg (계량형 도구)</option>
          </select>
          <label>이름</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="github" />
          {kind === "mcp" && (
            <>
              <label>MCP 엔드포인트 URL</label>
              <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.example.com/mcp" />
            </>
          )}
          {kind === "openapi" && (
            <>
              <label>스펙 URL</label>
              <input value={specUrl} onChange={(e) => setSpecUrl(e.target.value)} placeholder="https://api.example.com/openapi.json" />
              <label>또는 스펙 직접 붙여넣기</label>
              <textarea rows={4} value={spec} onChange={(e) => setSpec(e.target.value)} placeholder='{ "openapi": "3.0.0", ... }' />
              <label>base URL 덮어쓰기 (선택)</label>
              <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
            </>
          )}
          {(kind === "composio" || kind === "pipedream" || kind === "treg" || kind === "mcp") && (
            <>
              <label>{kind === "treg" ? "Treg baseUrl" : "API 키 (암호화 저장)"}</label>
              {kind === "treg" ? (
                <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://your-treg.example.com" />
              ) : (
                <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
              )}
            </>
          )}
        </div>
        <button
          className="btn primary"
          disabled={!name.trim()}
          onClick={async () => {
            try {
              const r = await api.createToolSource({
                name,
                kind,
                ...(url ? { url } : {}),
                ...(specUrl ? { specUrl } : {}),
                ...(spec ? { spec } : {}),
                ...(baseUrl ? { baseUrl } : {}),
                ...(apiKey ? { apiKey } : {}),
              });
              setFeedback(`연결 ${r.status}: ${r.detail ?? ""} ${r.tools.length ? "도구: " + r.tools.slice(0, 5).join(", ") : ""}`);
              setName("");
              setUrl("");
              setSpecUrl("");
              setSpec("");
              setApiKey("");
              refresh();
            } catch (e) {
              setFeedback(`실패: ${e instanceof Error ? e.message : String(e)}`);
            }
          }}
        >
          연결
        </button>
        {feedback && <p className="small feedback">{feedback}</p>}
      </div>

      {boot.toolSources.length === 0 && <p className="muted">연결된 툴 소스가 없습니다.</p>}
      {boot.toolSources.map((s) => (
        <div key={s.id} className="card row">
          <div>
            <strong>{s.name}</strong> <span className="badge">{s.kind}</span>{" "}
            <span className={`badge ${s.status === "ok" ? "ok" : s.status === "error" ? "off" : ""}`}>{s.status}</span>
            <div className="muted small">{s.status_detail ?? ""}</div>
            {s.tools.length > 0 && (
              <div className="chips">
                {s.tools.slice(0, 12).map((t) => (
                  <span key={t} className="chip static">
                    {t}
                  </span>
                ))}
                {s.tools.length > 12 && <span className="muted small">+{s.tools.length - 12}개</span>}
              </div>
            )}
          </div>
          <div className="row">
            <button
              className="btn"
              onClick={async () => {
                const r: { ok: boolean; count?: number; error?: string } = await api
                  .refreshToolSource(s.id)
                  .catch((e) => ({ ok: false, error: String(e.message ?? e) }));
                setFeedback(`${s.name}: ${r.ok ? `${r.count ?? 0}개 도구` : r.error}`);
                refresh();
              }}
            >
              새로고침
            </button>
            <button className="btn danger" onClick={async () => { await api.deleteToolSource(s.id); refresh(); }}>
              삭제
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
