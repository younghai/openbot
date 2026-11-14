import React, { useEffect, useState } from "react";
import { api } from "../api";
import type { Bootstrap, ModelPreset, PresetModel, Prompt, TtsProvider } from "../types";

export function Settings({ boot, refresh }: { boot: Bootstrap; refresh: () => void }): JSX.Element {
  return (
    <div className="page">
      <ProviderSection boot={boot} refresh={refresh} />
      <ModelPullSection refresh={refresh} />
      <PromptLibrarySection refresh={refresh} />
      <CredentialSection boot={boot} refresh={refresh} />
      <h2>스킬 라이브러리</h2>
      <p className="muted">
        SKILL.md 폴더 기반 스킬입니다. <code>data/skills/&lt;이름&gt;/SKILL.md</code>에 넣으면 봇이 <code>skills.read</code>로 읽습니다.
      </p>
      {boot.skills.map((s) => (
        <div key={s.name} className="card row">
          <div>
            <code>{s.name}</code>
            <div className="muted small">{s.description}</div>
          </div>
        </div>
      ))}
      <SkillProposalsSection refresh={refresh} />
    </div>
  );
}

/** 🧠 자동 학습: 대화에서 증류된 스킬 제안을 검토·승인하면 스킬 라이브러리에 반영된다. */
function SkillProposalsSection({ refresh }: { refresh: () => void }): JSX.Element {
  const [pending, setPending] = useState<{ id: string; name: string; description: string; content: string; created_at: number }[]>([]);
  const [history, setHistory] = useState<{ id: string; name: string; status: string }[]>([]);
  const [note, setNote] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  const load = () => {
    api.skillProposals("pending").then(setPending).catch(() => undefined);
    api.skillProposals().then((all) => setHistory(all.filter((p) => p.status !== "pending").slice(0, 10))).catch(() => undefined);
  };
  useEffect(load, []);

  return (
    <>
      <h2>🧠 스킬 학습</h2>
      <p className="muted">
        채팅 화면의 "이 대화에서 스킬 배우기"로 완성된 작업 절차를 제안받습니다. 승인하면 위 스킬 라이브러리에 반영되어 봇이 <code>skills.read</code>로 사용합니다. 로컬 모델로 증류 — 외부 전송 없음.
      </p>
      {note && <p className="test-result">{note}</p>}
      {pending.length === 0 && <div className="card muted">검토할 제안이 없습니다.</div>}
      {pending.map((p) => (
        <div key={p.id} className="card">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <div>
              <code>{p.name}</code> <span className="badge warn">제안</span>
              <div className="muted small">{p.description}</div>
            </div>
            <div className="row">
              <button className="btn primary" onClick={async () => {
                const r = await api.approveSkillProposal(p.id).catch((e) => ({ ok: false, error: String(e.message) }));
                setNote(r.ok ? `✅ ${p.name} 스킬로 반영됨` : r.error ?? "실패");
                load(); refresh();
              }}>승인·반영</button>
              <button className="btn danger" onClick={async () => {
                const r = await api.rejectSkillProposal(p.id).catch(() => ({ ok: false }));
                setNote(r.ok ? `${p.name} 거부됨` : "거부 실패");
                load();
              }}>거부</button>
              <button className="btn small" onClick={() => setOpen(open === p.id ? null : p.id)}>{open === p.id ? "접기" : "내용 보기"}</button>
            </div>
          </div>
          {open === p.id && <pre className="approval-args">{p.content}</pre>}
        </div>
      ))}
      {history.length > 0 && (
        <>
          <h3>처리 이력</h3>
          {history.map((h) => (
            <div key={h.id} className="card row">
              <span className="small"><code>{h.name}</code></span>
              <span className={`badge ${h.status === "approved" ? "ok" : "off"}`}>{h.status === "approved" ? "반영됨" : "거부"}</span>
            </div>
          ))}
        </>
      )}
    </>
  );
}

function ProviderSection({ boot, refresh }: { boot: Bootstrap; refresh: () => void }): JSX.Element {
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"openai-compatible" | "anthropic" | "mock">("openai-compatible");
  const [baseUrl, setBaseUrl] = useState("https://api.openai.com/v1");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("gpt-4o-mini");
  const [isDefault, setIsDefault] = useState(false);
  const [testResults, setTestResults] = useState<Record<string, string>>({});
  const [presets, setPresets] = useState<ModelPreset[]>([]);
  const [presetId, setPresetId] = useState("custom");
  const [presetModels, setPresetModels] = useState<PresetModel[]>([]);
  const [modelsNote, setModelsNote] = useState<string | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);

  useEffect(() => {
    api.listPresets().then(setPresets).catch(() => setPresets([]));
  }, []);

  const preset = presets.find((p) => p.id === presetId);

  const applyPreset = (id: string): void => {
    setPresetId(id);
    setPresetModels([]);
    setModelsNote(null);
    const p = presets.find((x) => x.id === id);
    if (!p) return;
    setKind(p.kind);
    if (p.baseUrl) setBaseUrl(p.baseUrl);
    if (!name.trim()) setName(id);
    if (p.requiresKey === false) setApiKey("");
  };

  const loadModels = async (): Promise<void> => {
    if (!preset?.discover) return;
    setLoadingModels(true);
    setModelsNote(null);
    try {
      const r = await api.listPresetModels(preset.id);
      if (r.ok && r.models && r.models.length > 0) {
        setPresetModels(r.models);
        setModel(r.models[0].name);
      } else {
        setModelsNote(r.ok ? "설치된 모델이 없습니다. 먼저 모델을 pull/install하세요." : `연결 실패: ${r.error ?? "알 수 없음"}`);
      }
    } finally {
      setLoadingModels(false);
    }
  };

  return (
    <>
      <h2>모델 자격증명 (BYO)</h2>
      <p className="muted">OpenAI 호환(Groq, OpenRouter, Ollama 등) 또는 Anthropic 키를 직접 넣습니다. 키는 AES-256-GCM으로 암호화 저장되며 다시 표시되지 않습니다.</p>
      <div className="card">
        <div className="form-grid">
          <label>프리셋</label>
          <div className="row">
            <select value={presetId} onChange={(e) => applyPreset(e.target.value)}>
              <option value="custom">직접 입력</option>
              {presets.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            {preset?.discover && (
              <button className="btn" disabled={loadingModels} onClick={loadModels}>
                {loadingModels ? "불러오는 중…" : "모델 목록 불러오기"}
              </button>
            )}
          </div>
          {preset && <div className="muted small" style={{ gridColumn: "2" }}>{preset.note}</div>}
          <label>이름</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="openai-main" />
          <label>종류</label>
          <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
            <option value="openai-compatible">OpenAI 호환</option>
            <option value="anthropic">Anthropic</option>
            <option value="mock">mock (키 불필요)</option>
          </select>
          <label>Base URL</label>
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} disabled={kind === "mock"} />
          <label>API 키</label>
          <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={preset && !preset.requiresKey ? "불필요 (로컬)" : "sk-…"} disabled={kind === "mock" || (preset !== undefined && !preset.requiresKey)} />
          <label>모델</label>
          {presetModels.length > 0 ? (
            <select value={model} onChange={(e) => setModel(e.target.value)}>
              {presetModels.map((m) => (
                <option key={m.name} value={m.name}>
                  {m.name}{m.capabilities?.includes("tools") ? " · tools" : ""}
                </option>
              ))}
            </select>
          ) : (
            <input value={model} onChange={(e) => setModel(e.target.value)} />
          )}
          {modelsNote && <div className="muted small" style={{ gridColumn: "2" }}>{modelsNote}</div>}
          <label>기본으로 사용</label>
          <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
        </div>
        <button
          className="btn primary"
          disabled={!name.trim() || !model.trim()}
          onClick={async () => {
            await api.createProvider({ name, kind, baseUrl: kind === "mock" ? undefined : baseUrl, apiKey: apiKey || undefined, model, isDefault });
            setName("");
            setApiKey("");
            setPresetId("custom");
            setPresetModels([]);
            refresh();
          }}
        >
          추가
        </button>
      </div>

      {boot.providers.map((p) => (
        <div key={p.id} className="card row">
          <div>
            <strong>{p.name}</strong> <span className="badge">{p.kind}</span> <code>{p.model}</code>{" "}
            {p.is_default === 1 && <span className="badge ok">기본 ★</span>}
            {p.hasKey && <span className="badge info">키 저장됨</span>}
            <div className="muted small">{p.base_url ?? "—"}</div>
            {testResults[p.id] && <div className="small test-result">{testResults[p.id]}</div>}
          </div>
          <div className="row">
            <button
              className="btn"
              onClick={async () => {
                const r = await api.testProvider(p.id);
                setTestResults((s) => ({ ...s, [p.id]: r.ok ? `응답: ${r.reply}` : `실패: ${r.error}` }));
              }}
            >
              테스트
            </button>
            {p.is_default !== 1 && (
              <button className="btn" onClick={async () => { await api.patchProvider(p.id, { isDefault: true }); refresh(); }}>
                기본으로
              </button>
            )}
            <button className="btn danger" onClick={async () => { await api.deleteProvider(p.id); refresh(); }}>
              삭제
            </button>
          </div>
        </div>
      ))}
    </>
  );
}

// ---------------------------------------------------------------- model pull (P0-A)

function ModelPullSection({ refresh }: { refresh: () => void }): JSX.Element {
  const [modelName, setModelName] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");

  return (
    <>
      <h2>모델 받기 (Ollama)</h2>
      <p className="muted">Ollama 모델을 다운로드합니다. 예: qwen3.5:4b, llama3.2:3b, phi3.5</p>
      <div className="card">
        <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
          <input
            style={{ flex: "1 1 200px" }}
            placeholder="모델 이름 (예: qwen3.5:14b)"
            value={modelName}
            onChange={(e) => setModelName(e.target.value)}
            onKeyDown={async (e) => {
              if (e.key === "Enter" && modelName.trim() && !busy) {
                setBusy(true); setNote("다운로드 중… (큰 모델은 몇 분 걸릴 수 있습니다)");
                try {
                  const r = await api.pullModel(modelName.trim());
                  setNote(r.ok ? `✅ ${modelName.trim()} 다운로드 완료` : `실패: ${r.error}`);
                  if (r.ok) { setModelName(""); refresh(); }
                } catch (err) {
                  setNote(`실패: ${err instanceof Error ? err.message : String(err)}`);
                } finally { setBusy(false); }
              }
            }}
          />
          <button
            className="btn primary"
            disabled={!modelName.trim() || busy}
            onClick={async () => {
              setBusy(true); setNote("다운로드 중… (큰 모델은 몇 분 걸릴 수 있습니다)");
              try {
                const r = await api.pullModel(modelName.trim());
                setNote(r.ok ? `✅ ${modelName.trim()} 다운로드 완료` : `실패: ${r.error}`);
                if (r.ok) { setModelName(""); refresh(); }
              } catch (err) {
                setNote(`실패: ${err instanceof Error ? err.message : String(err)}`);
              } finally { setBusy(false); }
            }}
          >
            {busy ? "받는 중…" : "다운로드"}
          </button>
        </div>
        {note && <p className="small" style={{ color: note.startsWith("✅") ? "var(--success)" : "var(--muted)" }}>{note}</p>}
      </div>
    </>
  );
}

// ---------------------------------------------------------------- prompt library (P1-C)

function PromptLibrarySection({ refresh }: { refresh: () => void }): JSX.Element {
  const [prompts, setPrompts] = useState<Prompt[]>([]);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");

  const load = () => api.prompts().then(setPrompts).catch(() => setPrompts([]));
  useEffect(() => { load(); }, []);

  return (
    <>
      <h2>프롬프트 라이브러리</h2>
      <p className="muted">자주 쓰는 프롬프트를 저장하고 채팅에서 / 로 빠르게 꺼냅니다.</p>
      <div className="card">
        <div className="form-grid">
          <label>제목</label>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="예: 코드 리뷰 요청" />
          <label>내용</label>
          <textarea rows={3} value={content} onChange={(e) => setContent(e.target.value)} placeholder="프롬프트 내용" />
        </div>
        <button
          className="btn primary small"
          disabled={!title.trim() || !content.trim()}
          onClick={async () => {
            await api.createPrompt(title.trim(), content.trim());
            setTitle(""); setContent(""); load();
          }}
        >
          저장
        </button>
      </div>
      {prompts.map((p) => (
        <div key={p.id} className="card row">
          <div>
            <strong>{p.title}</strong>
            <div className="muted small">{p.content.slice(0, 80)}…</div>
          </div>
          <button className="btn small danger" onClick={async () => { await api.deletePrompt(p.id); load(); }}>삭제</button>
        </div>
      ))}
    </>
  );
}

function CredentialSection({ boot, refresh }: { boot: Bootstrap; refresh: () => void }): JSX.Element {
  const [values, setValues] = useState<Record<string, string>>({});
  return (
    <>
      <h2>음성 & 외부 서비스 키</h2>
      <p className="muted">
        ElevenLabs/OpenAI/Cartesia/Fish 키로 음성 합성(TTS)과 받아쓰기(Whisper)를, Composio/Pipedream 키로 앱 연동을 켭니다. 브라우저 음성은 키가 없어도 동작합니다.
      </p>
      {boot.credentials.map((c) => (
        <div key={c.key} className="card row">
          <div>
            <code>{c.key}</code> {c.present ? <span className="badge ok">저장됨</span> : <span className="badge off">없음</span>}
          </div>
          <div className="row">
            <input
              type="password"
              placeholder="새 값"
              value={values[c.key] ?? ""}
              onChange={(e) => setValues((v) => ({ ...v, [c.key]: e.target.value }))}
            />
            <button
              className="btn primary"
              disabled={!(values[c.key] ?? "").trim()}
              onClick={async () => {
                await api.putCredential(c.key, values[c.key]);
                setValues((v) => ({ ...v, [c.key]: "" }));
                refresh();
              }}
            >
              저장
            </button>
            {c.present && (
              <button className="btn danger" onClick={async () => { await api.putCredential(c.key, ""); refresh(); }}>
                삭제
              </button>
            )}
          </div>
        </div>
      ))}
      <p className="muted small">
        음성 제공자 선택은 각 봇 만들기/편집에서 합니다 (browser / elevenlabs / openai / cartesia / fish).
      </p>
    </>
  );
}

export function ttsProviderLabel(p: TtsProvider): string {
  return { browser: "브라우저", elevenlabs: "ElevenLabs", openai: "OpenAI", cartesia: "Cartesia", fish: "Fish Audio" }[p];
}
