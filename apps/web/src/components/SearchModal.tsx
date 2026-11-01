import React, { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { SearchResults } from "../types";

/** 전역 검색 (⌘K): 대화 메시지·봇·메모리·작업. */
export function SearchModal({ onClose, onOpenChat }: { onClose: () => void; onOpenChat: (conversationId: string) => void }): JSX.Element {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SearchResults | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  useEffect(() => {
    if (q.trim().length < 2) { setResults(null); return; }
    const t = setTimeout(() => {
      api.search(q.trim()).then(setResults).catch(() => setResults(null));
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  const hit = results && (results.messages.length + results.bots.length + results.memories.length + results.tasks.length) > 0;

  return (
    <div className="wizard-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="wizard" style={{ maxWidth: 640 }}>
        <input ref={inputRef} autoFocus placeholder="대화·봇·메모리·작업 검색…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Escape" && onClose()} />
        {!results && q.trim().length >= 2 && <p className="muted small">검색 중…</p>}
        {results && !hit && <p className="muted small">결과 없음</p>}
        {results?.messages.length ? (
          <>
            <div className="side-title" style={{ marginTop: 8 }}>대화</div>
            {results.messages.slice(0, 8).map((m) => (
              <button key={m.id} className="search-hit" onClick={() => { onOpenChat(m.conversationId); onClose(); }}>
                <span className="badge">{m.role === "user" ? "나" : "봇"}</span>
                <span className="search-snippet">{m.snippet}</span>
                <span className="muted small">{new Date(m.created_at).toLocaleString()}</span>
              </button>
            ))}
          </>
        ) : null}
        {results?.tasks.length ? (
          <>
            <div className="side-title" style={{ marginTop: 8 }}>작업</div>
            {results.tasks.map((t) => (
              <div key={t.id} className="search-hit static"><span className="badge">{t.status}</span><span className="search-snippet">{t.title}</span></div>
            ))}
          </>
        ) : null}
        {results?.memories.length ? (
          <>
            <div className="side-title" style={{ marginTop: 8 }}>메모리</div>
            {results.memories.slice(0, 6).map((m) => (
              <div key={m.id} className="search-hit static"><span className="badge">{m.botName ?? "봇"}</span><span className="search-snippet">{m.content.slice(0, 120)}</span></div>
            ))}
          </>
        ) : null}
        {results?.bots.length ? (
          <>
            <div className="side-title" style={{ marginTop: 8 }}>봇</div>
            {results.bots.map((b) => (
              <div key={b.id} className="search-hit static"><span className="badge">{b.emoji}</span><span className="search-snippet">{b.name} — {b.persona?.slice(0, 80) || "페르소나 없음"}</span></div>
            ))}
          </>
        ) : null}
      </div>
    </div>
  );
}
