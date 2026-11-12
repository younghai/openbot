import React, { useEffect, useMemo, useRef, useState } from "react";
import { api, mediaUrl } from "../api";
import { subscribe } from "../ws";
import type { Approval, Bootstrap, Message } from "../types";
import { MemoryPanel } from "./MemoryPanel";
import { GenUICard } from "./GenUICard";
import { EditBotModal } from "./EditBotModal";

/* --- minimal Web Speech typings (not in TS DOM lib) --- */
interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: { length: number; [i: number]: { isFinal: boolean; 0: { transcript: string } } };
}
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: unknown) => void) | null;
  start: () => void;
  stop: () => void;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getRecognition(): SpeechRecognitionCtor | null {
  const w = window as unknown as { SpeechRecognition?: SpeechRecognitionCtor; webkitSpeechRecognition?: SpeechRecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

interface LiveTool {
  tool: string;
  result?: unknown;
}

export function ChatView({
  conversationId,
  boot,
  refresh,
}: {
  conversationId: string;
  boot: Bootstrap;
  refresh: () => void;
}): JSX.Element {
  const conv = boot.conversations.find((c) => c.id === conversationId);
  const bot = boot.bots.find((b) => b.id === conv?.bot_id) ?? null;
  const members = boot.channelMembers.filter((m) => m.conversation_id === conversationId).map((m) => m.bot_id);
  const botsInConv = conv?.kind === "channel" ? boot.bots.filter((b) => members.includes(b.id)) : bot ? [bot] : [];

  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [liveDelta, setLiveDelta] = useState("");
  const [liveTools, setLiveTools] = useState<LiveTool[]>([]);
  const [busyJob, setBusyJob] = useState<string | null>(null);
  const [speakOn, setSpeakOn] = useState(false);
  const [callMode, setCallMode] = useState(false);
  const [listening, setListening] = useState(false);
  const [showMemory, setShowMemory] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const [pendingApproval, setPendingApproval] = useState<Approval | null>(null);
  const [thinkingChars, setThinkingChars] = useState(0);
  const [savedPrompts, setSavedPrompts] = useState<{ id: string; title: string; content: string }[]>([]);
  const [pendingFiles, setPendingFiles] = useState<{ file: File; url: string }[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const callModeRef = useRef(false);
  const speakOnRef = useRef(false);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  callModeRef.current = callMode;
  speakOnRef.current = speakOn;

  const loadMessages = () => {
    api.messages(conversationId).then(setMessages).catch(() => undefined);
  };
  const loadOlder = async (): Promise<void> => {
    const oldest = messages[0];
    if (!oldest) return;
    const older = await api.messagesBefore(conversationId, oldest.created_at).catch(() => []);
    if (older.length > 0) setMessages((m) => [...older, ...m]);
  };

  useEffect(() => {
    api.prompts().then(setSavedPrompts).catch(() => setSavedPrompts([]));
  }, []);

  useEffect(() => {
    setLiveDelta("");
    setLiveTools([]);
    setBusyJob(null);
    setPendingApproval(null);
    loadMessages();
    // a pending approval may have been requested while this view was closed — restore it
    api.approvals("pending").then((rows) => {
      const mine = rows.find((r) => r.conversation_id === conversationId);
      if (mine) setPendingApproval(mine);
    }).catch(() => undefined);
    return subscribe((event) => {
      if (event.type === "chat.message" && event.conversationId === conversationId) {
        setLiveDelta("");
        setThinkingChars(0);
        loadMessages();
        if (event.role === "assistant") {
          if (speakOnRef.current || callModeRef.current) speak(event.content);
          if (callModeRef.current) setTimeout(() => startListening(), 400);
        }
      }
      if (event.type === "chat.accepted" && event.conversationId === conversationId) setBusyJob(event.jobId);
      if (event.type === "delta" && event.conversationId === conversationId) {
        setLiveDelta((d) => d + event.text);
        setThinkingChars(0);
      }
      if (event.type === "thinking" && event.conversationId === conversationId) setThinkingChars(event.chars);
      if ((event.type === "tool_start" || event.type === "tool_end") && event.conversationId === conversationId) {
        setLiveTools((tools) => {
          const idx = tools.findIndex((t) => t.tool === event.tool && t.result === undefined);
          if (event.type === "tool_start") return [...tools, { tool: event.tool }];
          if (idx >= 0) {
            const copy = [...tools];
            copy[idx] = { tool: event.tool, result: event.result };
            return copy;
          }
          return [...tools, { tool: event.tool, result: event.result }];
        });
      }
      if (event.type === "approval.requested" && event.approval.conversation_id === conversationId) {
        setPendingApproval(event.approval);
        // voice approval during call mode: ask out loud, listen for yes/no
        if (callModeRef.current && event.approval) {
          handleVoiceApproval(event.approval);
        }
      }
      if (event.type === "approval.decided") {
        setPendingApproval((p) => (p && p.id === event.id ? null : p));
      }
      if (event.type === "queue.update" && event.job.conversation_id === conversationId) {
        if (event.job.status === "done" || event.job.status === "error" || event.job.status === "cancelled") {
          setBusyJob(null);
          setLiveTools([]);
          loadMessages();
        }
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, liveDelta, liveTools.length]);

  const jobForConv = useMemo(
    () => boot.jobs.find((j) => j.conversation_id === conversationId && (j.status === "pending" || j.status === "running")),
    [boot.jobs, conversationId]
  );


  async function handleVoiceApproval(approval: { id: string; tool: string }): Promise<void> {
    const ask = `\ub3c4\uad6c ${approval.tool}\uc744 \uc2e4\ud589\ud560\uae4c\uc694? \uc74c\uc73c\ub85c \ub2f5\ud574\uc8fc\uc138\uc694. \ud5c8\uc6a9\uac19\uc73c\uba74 \ud558\uac83\uc74c, \uac70\ubd80\uac19\uc73c\uba74 \uc544\ub2c8\uac83\uc74c`;
    speak(ask);
    await new Promise((r) => setTimeout(r, Math.max(3000, ask.length * 100)));
    const Ctor = getRecognition();
    if (!Ctor) return;
    const rec = new Ctor();
    rec.lang = "ko-KR";
    rec.continuous = false;
    rec.interimResults = false;
    rec.onresult = (e) => {
      const said = e.results[0][0].transcript.toLowerCase();
      const yes = /\uc74c|\ud558\uac83|\ud5c8\uc6a9|\uc608|\uace0|\uc624\ucf00|ok|yes|allow/.test(said);
      const no = /\uc544\ub2c8|\uac70\ubd80|\ub188|\ub128|no|deny|stop/.test(said);
      if (yes && !no) {
        void api.approveTool(approval.id).catch(() => undefined);
        speak("\uc2b9\uc778\ud588\uc2b5\ub2c8\ub2e4");
      } else if (no) {
        void api.denyTool(approval.id).catch(() => undefined);
        speak("\uac70\ubd80\ud588\uc2b5\ub2c8\ub2e4");
      } else {
        speak("\uc798 \ubabb \uc54c\uc544\ub4e4\uc5c8\uc2b5\ub2c8\ub2e4. \ud654\uba74\uc5d0\uc11c \uacb0\uc815\ud574\uc8fc\uc138\uc694");
      }
    };
    rec.start();
    setTimeout(() => { try { rec.stop(); } catch { } }, 10000);
  }

  async function send(text: string): Promise<void> {
    const content = text.trim();
    if (!content && pendingFiles.length === 0) return;
    setInput("");
    setLiveDelta("");
    setThinkingChars(0);
    setLiveTools([]);
    let attachments: { path: string; name?: string; contentType?: string }[] | undefined;
    try {
      if (pendingFiles.length > 0) {
        const uploaded = await Promise.all(pendingFiles.map((f) => api.uploadAttachment(f.file)));
        attachments = uploaded.map((u) => ({ path: u.path, name: u.name, contentType: u.contentType }));
      }
      pendingFiles.forEach((f) => URL.revokeObjectURL(f.url));
      setPendingFiles([]);
      await api.sendMessage(conversationId, content, attachments);
    } catch (e) {
      setLiveDelta(`전송 실패: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  function addFiles(files: FileList | File[]): void {
    const imgs = [...files].filter((f) => f.type.startsWith("image/")).slice(0, 4 - pendingFiles.length);
    setPendingFiles((p) => [...p, ...imgs.map((file) => ({ file, url: URL.createObjectURL(file) }))]);
  }

  async function speak(text: string): Promise<void> {
    if (!text) return;
    const provider = bot?.tts_provider ?? "browser";
    const result = await api.tts(text, provider);
    if (result.audio) {
      const url = URL.createObjectURL(result.audio);
      if (!audioRef.current) {
        audioRef.current = new Audio();
      }
      audioRef.current.src = url;
      audioRef.current.onended = () => URL.revokeObjectURL(url);
      void audioRef.current.play().catch(() => undefined);
      return;
    }
    if (result.fallbackBrowser && "speechSynthesis" in window) {
      const utter = new SpeechSynthesisUtterance(text);
      utter.lang = "ko-KR";
      window.speechSynthesis.speak(utter);
    }
  }

  function startListening(): void {
    const Ctor = getRecognition();
    if (!Ctor) {
      setLiveDelta("이 브라우저는 음성 인식을 지원하지 않습니다 (Chrome/Edge 권장)");
      return;
    }
    const rec = new Ctor();
    recognitionRef.current = rec;
    rec.lang = "ko-KR";
    rec.continuous = false;
    rec.interimResults = true;
    rec.onresult = (e) => {
      let interim = "";
      let final = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) final += r[0].transcript;
        else interim += r[0].transcript;
      }
      setInput(final || interim);
      if (final) {
        setListening(false);
        void send(final);
      }
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    rec.start();
    setListening(true);
  }

  function toggleCall(): void {
    if (callMode) {
      setCallMode(false);
      recognitionRef.current?.stop();
      window.speechSynthesis?.cancel();
      audioRef.current?.pause();
      setListening(false);
    } else {
      setCallMode(true);
      setSpeakOn(true);
      startListening();
    }
  }

  if (!conv) return <div className="page muted">대화를 찾을 수 없습니다</div>;

  return (
    <div className="chat-page">
      <header className="chat-header">
        <div className="chat-title">
          {conv.kind === "channel" ? "#" : botsInConv[0]?.emoji ?? "🤖"} {conv.title ?? botsInConv.map((b) => b.name).join(", ")}
          <span className={`badge ${bot?.status === "paused" ? "warn" : "ok"}`}>
            {bot?.status === "paused" ? "일시정지" : "활동 중"}
          </span>
          {bot && (
            <span className="muted small">
              {boot.providers.find((p) => p.id === bot.provider_id)?.name
                ?? boot.providers.find((p) => p.is_default === 1)?.name
                ?? "mock"} ·{" "}
              {boot.computers.find((c) => c.id === bot.computer_id)?.name ?? "Team Computer"}
            </span>
          )}
        </div>
        <div className="chat-actions">
          {bot && (
            <button className="icon-btn" title={bot.status === "paused" ? "재개" : "일시정지"} onClick={async () => { await api.patchBot(bot.id, { status: bot.status === "paused" ? "active" : "paused" }); refresh(); }}>
              {bot.status === "paused" ? "▶" : "⏸"}
            </button>
          )}
          {bot && <button className={`icon-btn ${speakOn ? "on" : ""}`} title="응답 읽어주기" onClick={() => setSpeakOn(!speakOn)}>🔊</button>}
          {bot && <button className={`icon-btn call ${callMode ? "on" : ""}`} title="통화" onClick={toggleCall}>📞</button>}
          {bot && <button className={`icon-btn ${showMemory ? "on" : ""}`} title="메모리" onClick={() => setShowMemory(!showMemory)}>🧠</button>}
          {bot && <button className="icon-btn" title="봇 편집" onClick={() => setShowEdit(true)}>✏️</button>}
        </div>
      </header>
      {showEdit && bot && <EditBotModal boot={boot} bot={bot} onClose={() => setShowEdit(false)} refresh={refresh} />}

      {callMode && (
        <div className="call-banner">
          통화 중 — 말하면 봇이 듣고 답변을 소리로 읽어줍니다
          <button className="btn danger" onClick={toggleCall}>끊기</button>
        </div>
      )}

      {pendingApproval && (
        <div className="call-banner approval-banner">
          🔒 {pendingApproval.tool} 실행 승인 대기 중
          <span className="muted small">{pendingApproval.args?.slice(0, 80)}</span>
          <button className="btn primary small" onClick={async () => { await api.approveTool(pendingApproval.id).catch(() => undefined); setPendingApproval(null); }}>승인</button>
          <button className="btn danger small" onClick={async () => { await api.denyTool(pendingApproval.id).catch(() => undefined); setPendingApproval(null); }}>거부</button>
        </div>
      )}

      <div className={`chat-body ${showMemory ? "with-panel" : ""}`}>
        <div className="messages">
          {messages.length >= 60 && (
            <div className="load-more">
              <button className="btn small" onClick={() => void loadOlder()}>이전 메시지 불러오기</button>
            </div>
          )}
          {messages.length === 0 && (
            <div className="muted empty-chat">
              첫 메시지를 보내보세요. 모델 키 없이는 mock 봇이 도구 흐름을 시연합니다.
              <br />
              예: "terminal 로 run 해줘", "https://example.com fetch 해줘", "이것 좀 remember 해줘"
            </div>
          )}
          {messages.map((m) => (
            <MessageRow key={m.id} m={m} bots={boot.bots} />
          ))}
          {liveTools.map((t, i) => (
            <ToolCard key={`live-${i}-${t.tool}`} name={t.tool} result={t.result} pending={t.result === undefined} />
          ))}
          {(liveDelta || busyJob || jobForConv || thinkingChars > 0) && (
            <div className="msg assistant">
              <div className="bubble typing">{liveDelta || (thinkingChars > 0 ? `🧠 생각 중… (${thinkingChars.toLocaleString()}자)` : "…")}</div>
            </div>
          )}
          {jobForConv && !liveDelta && (
            <div className="muted small queue-line">
              큐: {jobForConv.status === "pending" ? "대기 중" : "실행 중"}…
              <button className="btn small danger" onClick={() => void api.cancelJob(jobForConv.id)}>취소</button>
            </div>
          )}
          <div ref={bottomRef} />
        </div>
        {showMemory && bot && <MemoryPanel botId={bot.id} />}
      </div>

      <footer className="chat-input">
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          style={{ display: "none" }}
          onChange={(e) => {
            if (e.target.files?.length) addFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <button className="icon-btn" title="이미지 첨부 (비전)" onClick={() => fileInputRef.current?.click()}>📎</button>
        <button className={`icon-btn mic ${listening ? "on" : ""}`} title="받아쓰기" onClick={() => (listening ? recognitionRef.current?.stop() : startListening())}>
          🎤
        </button>
        <textarea
          value={input}
          placeholder={listening ? "듣고 있습니다…" : "메시지 입력 (Enter 전송, 이미지 붙여넣기 가능)"}
          onChange={(e) => {
                setInput(e.target.value);
                // / autocomplete: insert first matching saved prompt
                const v = e.target.value;
                if (v.startsWith("/") && savedPrompts.length > 0) {
                  const match = savedPrompts.find((p) => p.title.toLowerCase().startsWith(v.slice(1).toLowerCase()));
                  if (match) {
                    setInput(match.content);
                    return;
                  }
                }
              }}
          onPaste={(e) => {
            const files = [...(e.clipboardData?.files ?? [])];
            if (files.length > 0) {
              e.preventDefault();
              addFiles(files);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send(e.currentTarget.value);
            }
          }}
          rows={2}
        />
        <button className="btn primary" disabled={!input.trim() && pendingFiles.length === 0} onClick={() => void send(input)}>
          전송
        </button>
        {pendingFiles.length > 0 && (
          <div className="attach-preview">
            {pendingFiles.map((f, i) => (
              <span key={f.url} className="attach-chip">
                <img src={f.url} alt={f.file.name} />
                <button className="attach-x" onClick={() => setPendingFiles((p) => p.filter((_, j) => j !== i))}>×</button>
              </span>
            ))}
          </div>
        )}
      </footer>
    </div>
  );
}

function MessageRow({ m, bots }: { m: Message; bots: Bootstrap["bots"] }): JSX.Element | null {
  if (m.role === "system") {
    return <div className="compact-note">💬 이전 대화 요약으로 압축됨</div>;
  }
  if (m.role === "tool") {
    let result: unknown = m.tool_result;
    try {
      result = JSON.parse(m.tool_result ?? "");
    } catch {
      /* keep raw */
    }
    return <ToolCard name={m.tool_name ?? "?"} result={result} />;
  }
  const bot = bots.find((b) => b.id === m.bot_id);
  if (m.role === "user" && !m.bot_id) {
    let attachments: { path: string; name?: string }[] = [];
    try {
      const meta = m.meta ? (JSON.parse(m.meta) as { attachments?: { path: string; name?: string }[] }) : {};
      attachments = meta.attachments ?? [];
    } catch {
      /* no attachments */
    }
    return (
      <div className="msg user">
        <div className="bubble">
          {attachments.length > 0 && (
            <div className="attach-row">
              {attachments.map((a) => (
                <img key={a.path} className="attach-thumb" src={`/api/media/${a.path}`} alt={a.name ?? "첨부 이미지"} />
              ))}
            </div>
          )}
          {m.content.startsWith("[delegated by") ? <em className="muted">{m.content.split("]")[0]}]</em> : null}{" "}
          {m.content.replace(/^\[delegated by [^\]]+\]\s*/, "")}
        </div>
      </div>
    );
  }
  return (
    <div className="msg assistant">
      <div className="avatar">{bot?.emoji ?? "🤖"}</div>
      <div className="bubble">{m.content || <span className="muted">(도구 호출 턴)</span>}</div>
      {m.content && (
        <div className="feedback-row">
          <button className="icon-btn feedback" title="좋아요" onClick={() => void api.sendFeedback(m.id, m.conversation_id, m.bot_id, "up").catch(() => undefined)}>👍</button>
          <button className="icon-btn feedback" title="별로예요" onClick={() => void api.sendFeedback(m.id, m.conversation_id, m.bot_id, "down").catch(() => undefined)}>👎</button>
        </div>
      )}
    </div>
  );
}

function ToolCard({ name, result, pending }: { name: string; result?: unknown; pending?: boolean }): JSX.Element {
  const [open, setOpen] = useState(false);
  const mediaPaths: string[] = [];
  if (result && typeof result === "object") {
    for (const value of Object.values(result as Record<string, unknown>)) {
      if (typeof value === "string" && value.startsWith("/api/media/")) mediaPaths.push(value);
    }
  }
  // Generative UI: render OpenUI Lang output as rich components
  if (name === "ui.render" && result && typeof result === "object") {
    const r = result as { rendered?: boolean; code?: string };
    if (r.rendered && r.code) {
      return (
        <div className="genui-wrapper">
          <GenUICard code={r.code} />
        </div>
      );
    }
  }
  return (
    <div className={`tool-card ${pending ? "pending" : ""}`}>
      <button className="tool-head" onClick={() => setOpen(!open)}>
        <span className="tool-icon">🔧</span> {name} {pending ? "실행 중…" : ""}
      </button>
      {mediaPaths.map((p) => (
        <img key={p} className="attachment" src={mediaUrl(p)} alt={`${name} 결과 이미지`} />
      ))}
      {open && <pre className="tool-body">{result === undefined ? "(대기 중)" : JSON.stringify(result, null, 2).slice(0, 4000)}</pre>}
    </div>
  );
}
