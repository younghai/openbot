import React, { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { subscribe } from "./ws";
import type { Bootstrap, BotTemplate, NotificationRow } from "./types";
import { ChatView } from "./components/ChatView";
import { Channels } from "./components/Channels";
import { Computers } from "./components/Computers";
import { Routines } from "./components/Routines";
import { ToolSources } from "./components/ToolSources";
import { Settings } from "./components/Settings";
import { AuditLog } from "./components/AuditLog";
import { Inbox } from "./components/Inbox";
import { Board } from "./components/Board";
import { Dashboard } from "./components/Dashboard";
import { Files } from "./components/Files";
import { Wizard } from "./components/Wizard";
import { SearchModal } from "./components/SearchModal";

export type Page =
  | { kind: "chat"; conversationId: string }
  | { kind: "channels" }
  | { kind: "board" }
  | { kind: "inbox" }
  | { kind: "dashboard" }
  | { kind: "files" }
  | { kind: "computers" }
  | { kind: "routines" }
  | { kind: "sources" }
  | { kind: "settings" }
  | { kind: "audit" };

export function App(): JSX.Element {
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [error, setError] = useState<string>("");
  const [page, setPage] = useState<Page>({ kind: "channels" });
  const [wsOn, setWsOn] = useState(false);
  const [pendingApprovals, setPendingApprovals] = useState(0);
  const [notifications, setNotifications] = useState<NotificationRow[]>([]);
  const [bellOpen, setBellOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [adminOpen, setAdminOpen] = useState(false);
  const [wizardDone, setWizardDone] = useState(() => localStorage.getItem("openbotWizardDone") === "1");
  const unread = notifications.filter((n) => !n.read_at).length;

  const refresh = useCallback(() => {
    api.bootstrap().then(setBoot).catch((e) => setError(String(e.message ?? e)));
    api.approvals("pending").then((r) => setPendingApprovals(r.length)).catch(() => undefined);
  }, []);

  const loadNotifications = useCallback(() => {
    api.notifications().then(setNotifications).catch(() => undefined);
  }, []);

  useEffect(() => {
    refresh();
    loadNotifications();
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return subscribe((event) => {
      if (event.type === "hello") {
        setWsOn(true);
        refresh();
      }
      if (event.type === "chat.message" || event.type === "queue.update") refresh();
      if (event.type === "approval.requested") setPendingApprovals((n) => n + 1);
      if (event.type === "approval.decided") setPendingApprovals((n) => Math.max(0, n - 1));
      if (event.type === "notification.new") loadNotifications();
    });
  }, [refresh, loadNotifications]);

  // Spotlight effect: track mouse position for card glow (must be before any conditional return)
  useEffect(() => {
    const onMouseMove = (e: MouseEvent): void => {
      const card = (e.target as HTMLElement).closest?.(".card, .template-card") as HTMLElement | null;
      if (card) {
        const rect = card.getBoundingClientRect();
        card.style.setProperty("--mx", `${e.clientX - rect.left}px`);
        card.style.setProperty("--my", `${e.clientY - rect.top}px`);
      }
    };
    document.addEventListener("mousemove", onMouseMove);
    return () => document.removeEventListener("mousemove", onMouseMove);
  }, []);

  const botFor = (conversationId: string) => {
    const conv = boot?.conversations.find((c) => c.id === conversationId);
    return boot?.bots.find((b) => b.id === conv?.bot_id) ?? null;
  };

  const dmConversations = (boot?.conversations ?? []).filter((c) => c.kind === "dm");
  const channelConversations = (boot?.conversations ?? []).filter((c) => c.kind === "channel");

  if (error) {
    return (
      <div className="app error-screen">
        <p>서버에 연결할 수 없습니다: {error}</p>
        <p className="muted">서버 실행: pnpm dev:server (또는 pnpm start)</p>
      </div>
    );
  }
  if (!boot) return <div className="app error-screen muted">불러오는 중…</div>;

  return (
    <>
      <div className="aurora" />
      <div className="app">
      {boot.bots.length === 0 && !wizardDone && (
        <Wizard onDone={(conversationId) => { localStorage.setItem("openbotWizardDone", "1"); setWizardDone(true); refresh(); setPage({ kind: "chat", conversationId }); }} />
      )}
      {searchOpen && <SearchModal onClose={() => setSearchOpen(false)} onOpenChat={(id) => setPage({ kind: "chat", conversationId: id })} />}
      <aside className="sidebar">
        <div className="brand">
          OpenBot <span className="brand-sub">그록봇 대체재</span>
          <span className={`ws-dot ${wsOn ? "on" : ""}`} title={wsOn ? "실시간 연결됨" : "연결 중"} />
          <button className={`icon-btn bell ${unread > 0 ? "on" : ""}`} title={`알림 ${unread}건`} onClick={() => setBellOpen(!bellOpen)}>
            🔔{unread > 0 && <span className="bell-badge">{unread}</span>}
          </button>
        </div>

        {bellOpen && (
          <div className="bell-panel">
            <div className="row" style={{ justifyContent: "space-between", padding: "6px 10px" }}>
              <strong className="small">알림</strong>
              <button className="btn small" onClick={async () => { await api.markNotificationsRead(); loadNotifications(); }}>모두 읽음</button>
            </div>
            {notifications.length === 0 && <div className="muted small" style={{ padding: 10 }}>알림이 없습니다</div>}
            {notifications.slice(0, 15).map((n) => (
              <div key={n.id} className={`bell-item ${n.read_at ? "" : "unread"}`}>
                <span className="badge">{n.kind}</span>
                <div className="small">{n.title}</div>
                {n.body && <div className="muted small">{n.body.slice(0, 80)}</div>}
                <div className="muted small">{new Date(n.created_at).toLocaleString()}</div>
              </div>
            ))}
          </div>
        )}

        <div className="side-section">
          <button className="side-item search-btn" onClick={() => setSearchOpen(true)}>
            <span className="side-emoji">🔍</span>
            <span className="side-name">검색</span>
            <span className="muted small">⌘K</span>
          </button>
        </div>

        <div className="side-section">
          <div className="side-title">봇</div>
          {dmConversations.length === 0 && <div className="muted small">봇이 없습니다 — 아래에서 만들세요</div>}
          {dmConversations.map((conv) => {
            const bot = botFor(conv.id);
            return (
              <button
                key={conv.id}
                className={`side-item ${page.kind === "chat" && page.conversationId === conv.id ? "active" : ""}`}
                onClick={() => setPage({ kind: "chat", conversationId: conv.id })}
              >
                <span className="side-emoji">{bot?.emoji ?? "🤖"}</span>
                <span className="side-name">{bot?.name ?? "?"}</span>
                {bot?.status === "paused" && <span className="badge warn">일시정지</span>}
              </button>
            );
          })}
          <NewBotInline refresh={refresh} boot={boot} onOpenChat={(id) => setPage({ kind: "chat", conversationId: id })} />
        </div>

        <div className="side-section">
          <div className="side-title">채널</div>
          {channelConversations.map((conv) => (
            <button
              key={conv.id}
              className={`side-item ${page.kind === "chat" && page.conversationId === conv.id ? "active" : ""}`}
              onClick={() => setPage({ kind: "chat", conversationId: conv.id })}
            >
              <span className="side-emoji">#</span>
              <span className="side-name">{conv.title ?? "channel"}</span>
            </button>
          ))}
          <button
            className={`side-item ${page.kind === "channels" && !channelConversations.length ? "active" : ""}`}
            onClick={() => setPage({ kind: "channels" })}
          >
            <span className="side-emoji">+</span>
            <span className="side-name muted">채널 만들기</span>
          </button>
        </div>

        <div className="side-section">
          <div className="side-title">작업</div>
          <button className={`side-item ${page.kind === "board" ? "active" : ""}`} onClick={() => setPage({ kind: "board" })}>
            <span className="side-emoji">📋</span>
            <span className="side-name">작업 보드</span>
          </button>
          <button className={`side-item ${page.kind === "dashboard" ? "active" : ""}`} onClick={() => setPage({ kind: "dashboard" })}>
            <span className="side-emoji">📊</span>
            <span className="side-name">대시보드</span>
          </button>
          <button className={`side-item ${page.kind === "inbox" ? "active" : ""}`} onClick={() => setPage({ kind: "inbox" })}>
            <span className="side-emoji">🔒</span>
            <span className="side-name">승인</span>
            {pendingApprovals > 0 && <span className="badge warn">{pendingApprovals}</span>}
          </button>
        </div>

        <div className="side-section">
          <button
            className={`side-group-toggle ${["computers","routines","sources","settings","audit","files"].includes(page.kind) ? "active" : ""}`}
            onClick={() => setAdminOpen(!adminOpen)}
          >
            <span className="side-emoji">⚙️</span>
            <span className="side-name">설정 · 관리</span>
            <span className="side-chevron">{adminOpen ? "▾" : "▸"}</span>
          </button>
          {adminOpen && (
            <div className="side-group-body">
              <button className={`side-item sub ${page.kind === "files" ? "active" : ""}`} onClick={() => setPage({ kind: "files" })}>
                <span className="side-emoji">📁</span>
                <span className="side-name">파일 · 지식</span>
              </button>
              <button className={`side-item sub ${page.kind === "computers" ? "active" : ""}`} onClick={() => setPage({ kind: "computers" })}>
                <span className="side-emoji">💻</span>
                <span className="side-name">컴퓨터</span>
              </button>
              <button className={`side-item sub ${page.kind === "routines" ? "active" : ""}`} onClick={() => setPage({ kind: "routines" })}>
                <span className="side-emoji">⏰</span>
                <span className="side-name">루틴</span>
              </button>
              <button className={`side-item sub ${page.kind === "sources" ? "active" : ""}`} onClick={() => setPage({ kind: "sources" })}>
                <span className="side-emoji">🔌</span>
                <span className="side-name">툴 소스</span>
              </button>
              <button className={`side-item sub ${page.kind === "settings" ? "active" : ""}`} onClick={() => setPage({ kind: "settings" })}>
                <span className="side-emoji">⚙️</span>
                <span className="side-name">설정</span>
              </button>
              <button className={`side-item sub ${page.kind === "audit" ? "active" : ""}`} onClick={() => setPage({ kind: "audit" })}>
                <span className="side-emoji">📜</span>
                <span className="side-name">감사 로그</span>
              </button>
            </div>
          )}
        </div>

        <div className="side-footer muted small">
          {boot.bots.length} 봇 · {boot.skills.length} 스킬
        </div>
      </aside>

      <main className="main">
        {page.kind === "chat" && <ChatView key={page.conversationId} conversationId={page.conversationId} boot={boot} refresh={refresh} />}
        {page.kind === "channels" && <Channels boot={boot} refresh={refresh} onOpen={(id) => setPage({ kind: "chat", conversationId: id })} />}
        {page.kind === "board" && <Board boot={boot} refresh={refresh} onOpenChat={(id) => setPage({ kind: "chat", conversationId: id })} />}
        {page.kind === "dashboard" && <Dashboard />}
        {page.kind === "files" && <Files boot={boot} />}
        {page.kind === "inbox" && <Inbox boot={boot} />}
        {page.kind === "computers" && <Computers boot={boot} refresh={refresh} />}
        {page.kind === "routines" && <Routines boot={boot} refresh={refresh} />}
        {page.kind === "sources" && <ToolSources boot={boot} refresh={refresh} />}
        {page.kind === "settings" && <Settings boot={boot} refresh={refresh} />}
        {page.kind === "audit" && <AuditLog boot={boot} />}
      </main>
      </div>
    </>
  );
}

function NewBotInline({ refresh, boot, onOpenChat }: { refresh: () => void; boot: Bootstrap; onOpenChat: (id: string) => void }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [emoji, setEmoji] = useState("🤖");
  const [persona, setPersona] = useState("");
  const [providerId, setProviderId] = useState("");
  const [computerId, setComputerId] = useState("");
  const [tts, setTts] = useState("browser");
  const [busy, setBusy] = useState(false);

  const [templates, setTemplates] = useState<BotTemplate[]>([]);
  useEffect(() => { if (open) api.botTemplates().then(setTemplates).catch(() => setTemplates([])); }, [open]);

  if (!open) {
    return (
      <button className="side-item new-bot" onClick={() => setOpen(true)}>
        + 새 봇
      </button>
    );
  }
  return (
    <div className="new-bot-form">
      {templates.length > 0 && (
        <div style={{ marginBottom: 8 }}>
          <div className="muted small" style={{ marginBottom: 4 }}>템플릿에서 만들기</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {templates.map((t) => (
              <button key={t.id} className="btn small" title={t.description}
                onClick={async () => {
                  const r = await api.createFromTemplate(t.id).catch(() => null);
                  if (r) { setOpen(false); refresh(); onOpenChat(r.conversationId); }
                }}>
                {t.icon} {t.title}
              </button>
            ))}
          </div>
          <div className="muted small" style={{ margin: "6px 0" }}>— 또는 직접 만들기 —</div>
        </div>
      )}
      <input placeholder="이름" value={name} onChange={(e) => setName(e.target.value)} />
      <input placeholder="이모지" value={emoji} onChange={(e) => setEmoji(e.target.value)} className="emoji-input" />
      <textarea placeholder="성격/페르소나" value={persona} onChange={(e) => setPersona(e.target.value)} rows={2} />
      <select value={providerId} onChange={(e) => setProviderId(e.target.value)}>
        <option value="">모델: 없음 (mock)</option>
        {boot.providers.map((p) => (
          <option key={p.id} value={p.id}>
            모델: {p.name} ({p.model}){p.is_default ? " ★" : ""}
          </option>
        ))}
      </select>
      <select value={computerId} onChange={(e) => setComputerId(e.target.value)}>
        <option value="">컴퓨터: 기본 (Team Computer)</option>
        {boot.computers.map((c) => (
          <option key={c.id} value={c.id}>
            컴퓨터: {c.name} ({c.kind})
          </option>
        ))}
      </select>
      <select value={tts} onChange={(e) => setTts(e.target.value)}>
        <option value="browser">음성: 브라우저 (키 불필요)</option>
        <option value="elevenlabs">음성: ElevenLabs</option>
        <option value="openai">음성: OpenAI</option>
        <option value="cartesia">음성: Cartesia</option>
        <option value="fish">음성: Fish Audio</option>
      </select>
      <div className="row">
        <button
          className="btn primary"
          disabled={!name.trim() || busy}
          onClick={async () => {
            setBusy(true);
            try {
              await api.createBot({ name, emoji, persona, providerId: providerId || undefined, computerId: computerId || undefined, ttsProvider: tts });
              setName("");
              setPersona("");
              setOpen(false);
              refresh();
            } finally {
              setBusy(false);
            }
          }}
        >
          만들기
        </button>
        <button className="btn" onClick={() => setOpen(false)}>
          취소
        </button>
      </div>
    </div>
  );
}
