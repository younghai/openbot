import React, { useEffect, useState } from "react";
import { api } from "../api";
import type { Bootstrap, Checkpoint, FileEntry } from "../types";

/** 파일 워크스페이스: 메모리(md)·컴퓨터 워크스페이스 브라우저/미리보기/편집 + 체크포인트 복원. */
export function Files({ boot }: { boot: Bootstrap }): JSX.Element {
  const [scope, setScope] = useState<"memory" | "workspace" | "knowledge">("memory");
  const [computerId, setComputerId] = useState("");
  const [dirPath, setDirPath] = useState("");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [selected, setSelected] = useState<{ path: string; content?: string; image?: boolean } | null>(null);
  const [editBuffer, setEditBuffer] = useState<string>("");
  const [note, setNote] = useState("");
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [botId, setBotId] = useState("");
  const [knowledgeDocs, setKnowledgeDocs] = useState<{ source: string; chunks: number }[]>([]);
  const [knowledgeQuery, setKnowledgeQuery] = useState("");
  const [knowledgeResults, setKnowledgeResults] = useState<{ source: string; content: string; chunk_index: number }[]>([]);

  const fileScope = scope === "knowledge" ? "memory" : scope;

  const load = (): void => {
    if (scope === "knowledge") return;
    api.files(fileScope, scope === "workspace" ? computerId || undefined : undefined, undefined, dirPath)
      .then((r) => setEntries(r.entries))
      .catch((e) => { setEntries([]); setNote(String(e.message ?? e)); });
    api.checkpoints().then(setCheckpoints).catch(() => undefined);
  };

  useEffect(() => { load(); setSelected(null); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [scope, computerId, dirPath]);

  const loadKnowledge = (): void => {
    if (scope !== "knowledge" || !botId) return;
    api.knowledgeDocs(botId).then((r) => setKnowledgeDocs(r.documents)).catch(() => setKnowledgeDocs([]));
  };
  useEffect(() => { loadKnowledge(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [scope, botId]);

  const openFile = async (name: string): Promise<void> => {
    const p = dirPath ? `${dirPath}/${name}` : name;
    if (/\.(png|jpe?g|webp|gif)$/i.test(name)) {
      setSelected({ path: p, image: true });
      return;
    }
    try {
      const r = await api.fileContent(fileScope, p, scope === "workspace" ? computerId || undefined : undefined);
      setSelected({ path: p, content: r.content });
      setEditBuffer(r.content);
    } catch (e) {
      setNote(`열기 실패: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const save = async (): Promise<void> => {
    if (!selected) return;
    const r = await api.saveFile({ scope: fileScope, path: selected.path, content: editBuffer, computerId: scope === "workspace" ? computerId || undefined : undefined }).catch((e) => null);
    setNote(r?.ok ? "저장됨" : "저장 실패");
  };

  const crumbs = (): string[] => (dirPath ? dirPath.split("/") : []);

  return (
    <div className="page">
      <h2>파일</h2>
      <p className="muted">봇의 Markdown 메모리와 컴퓨터 워크스페이스를 직접 열람·편집합니다. 위험 도구 실행 전 자동 스냅샷(체크포인트)도 여기서 복원합니다.</p>

      <div className="row" style={{ gap: 8, marginBottom: 10 }}>
        <button className={`btn ${scope === "memory" ? "primary" : ""}`} onClick={() => { setScope("memory"); setDirPath(""); }}>🧠 메모리</button>
        <button className={`btn ${scope === "workspace" ? "primary" : ""}`} onClick={() => { setScope("workspace"); setDirPath(""); }}>💻 워크스페이스</button>
        <button className={`btn ${scope === "knowledge" ? "primary" : ""}`} onClick={() => { setScope("knowledge"); setDirPath(""); }}>📚 지식</button>
        {scope === "workspace" && (
          <select value={computerId} onChange={(e) => { setComputerId(e.target.value); setDirPath(""); }}>
            <option value="">기본 Team Computer</option>
            {boot.computers.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.kind})</option>)}
          </select>
        )}
        {scope === "knowledge" && (
          <select value={botId} onChange={(e) => setBotId(e.target.value)}>
            <option value="">봇 선택…</option>
            {boot.bots.map((b) => <option key={b.id} value={b.id}>{b.emoji} {b.name}</option>)}
          </select>
        )}
      </div>

      {scope === "knowledge" && botId && (
        <div className="card" style={{ marginBottom: 12 }}>
          <div className="row" style={{ gap: 8, marginBottom: 8 }}>
            <input placeholder="지식 검색…" value={knowledgeQuery} onChange={(e) => setKnowledgeQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && knowledgeQuery.trim().length >= 2) {
                  fetch(`/api/knowledge/search?botId=${botId}&q=${encodeURIComponent(knowledgeQuery.trim())}`)
                    .then((r) => r.json()).then((d) => setKnowledgeResults(d.results ?? [])).catch(() => setKnowledgeResults([]));
                }
              }}
              style={{ flex: 1 }} />
            <button className="btn small" onClick={() => {
              if (knowledgeQuery.trim().length >= 2) {
                fetch(`/api/knowledge/search?botId=${botId}&q=${encodeURIComponent(knowledgeQuery.trim())}`)
                  .then((r) => r.json()).then((d) => setKnowledgeResults(d.results ?? [])).catch(() => setKnowledgeResults([]));
              }
            }}>검색</button>
          </div>
          {knowledgeDocs.length === 0 && <p className="muted small">색인된 문서가 없습니다. 봇에게 knowledge.index 도구로 파일을 색인하라고 하세요.</p>}
          {knowledgeDocs.map((d) => (
            <div key={d.source} className="card row" style={{ padding: "6px 10px", marginBottom: 4 }}>
              <span className="small">📄 {d.source}</span>
              <span className="muted small">{d.chunks}청크</span>
              <button className="btn small danger" onClick={async () => {
                await fetch(`/api/knowledge/${botId}/${encodeURIComponent(d.source)}`, { method: "DELETE" });
                loadKnowledge();
              }}>삭제</button>
            </div>
          ))}
          {knowledgeResults.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <div className="muted small">검색 결과 ({knowledgeResults.length}개)</div>
              {knowledgeResults.map((r, i) => (
                <div key={i} className="card" style={{ padding: "8px 10px", marginBottom: 4, fontSize: 12 }}>
                  <span className="badge">{r.source}</span> #{r.chunk_index}
                  <div className="muted" style={{ marginTop: 2 }}>{r.content.slice(0, 200)}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {scope !== "knowledge" && (<div className="files-layout">
        <div className="files-list">
          <div className="muted small" style={{ padding: "4px 6px" }}>
            / {crumbs().join(" / ")}
            {dirPath && <button className="btn small" style={{ marginLeft: 8 }} onClick={() => setDirPath(crumbs().slice(0, -1).join("/"))}>↑ 상위</button>}
          </div>
          {entries.map((e) => (
            <button key={e.name} className="file-row" onClick={() => (e.type === "dir" ? setDirPath(dirPath ? `${dirPath}/${e.name}` : e.name) : void openFile(e.name))}>
              <span>{e.type === "dir" ? "📁" : /\.(md|txt)$/i.test(e.name) ? "📄" : /\.(png|jpe?g|webp|gif)$/i.test(e.name) ? "🖼" : "📄"}</span>
              <span className="file-name">{e.name}</span>
              <span className="muted small">{e.type === "file" ? `${Math.max(1, Math.round(e.size / 1024))}KB` : ""}</span>
            </button>
          ))}
          {entries.length === 0 && <div className="muted small" style={{ padding: 8 }}>빈 디렉터리</div>}
        </div>
        <div className="files-preview">
          {!selected && <div className="muted small">파일을 선택하면 여기에 표시됩니다</div>}
          {selected?.image && <img style={{ maxWidth: "100%", borderRadius: 8 }} src={api.fileContentUrl(scope, selected.path, scope === "workspace" ? computerId || undefined : undefined)} alt={selected.path} />}
          {selected?.content !== undefined && (
            <>
              <div className="muted small">{selected.path}</div>
              <textarea className="file-editor" value={editBuffer} onChange={(e) => setEditBuffer(e.target.value)} rows={18} />
              <button className="btn primary small" onClick={() => void save()}>저장</button>
            </>
          )}
          {note && <p className="small feedback">{note}</p>}
        </div>
      </div>

      )}

      <h3>체크포인트 (최근 10개 워크스페이스 유지)</h3>
      {checkpoints.length === 0 && <p className="muted small">아직 스냅샷이 없습니다 — 승인된 터미널/파일 쓰기 실행 전 자동 생성됩니다.</p>}
      {checkpoints.slice(0, 12).map((cp) => (
        <div key={cp.id} className="card row">
          <div>
            <code>{cp.label}</code> <span className="badge">{Math.round(cp.bytes / 1024)}KB</span>
            <div className="muted small">{new Date(cp.created_at).toLocaleString()} · {cp.reason ?? ""}</div>
          </div>
          <div className="row">
            <button className="btn small warn-btn" onClick={async () => {
              if (!confirm("워크스페이스를 이 스냅샷 시점으로 되돌립니다. 이후 변경은 사라집니다. 계속?")) return;
              const r = await api.restoreCheckpoint(cp.id);
              setNote(r.ok ? "복원 완료" : `복원 실패: ${r.error}`);
              load();
            }}>복원</button>
            <button className="btn small danger" onClick={async () => { await api.deleteCheckpoint(cp.id); load(); }}>삭제</button>
          </div>
        </div>
      ))}
    </div>
  );
}
