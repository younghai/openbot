import React, { useEffect, useState } from "react";
import { api } from "../api";
import type { BotTemplate, PresetModel } from "../types";

/** 첫 실행 온보딩: 템플릿 선택 → (직접 입력 시) 이름·모델 → 첫 질문 자동 발사. */
export function Wizard({ onDone }: { onDone: (conversationId: string) => void }): JSX.Element {
  const [step, setStep] = useState(1);
  const [templates, setTemplates] = useState<BotTemplate[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<string>("");
  const [name, setName] = useState("");
  const [persona, setPersona] = useState("");
  const [ollamaOk, setOllamaOk] = useState<boolean | null>(null);
  const [models, setModels] = useState<PresetModel[]>([]);
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api.botTemplates().then(setTemplates).catch(() => setTemplates([]));
    api.listPresetModels("ollama")
      .then((r) => {
        if (r.ok && r.models && r.models.length > 0) {
          setOllamaOk(true);
          setModels(r.models);
          const tools = r.models.find((m) => m.capabilities?.includes("tools")) ?? r.models[0];
          setModel(tools.name);
        } else {
          setOllamaOk(false);
        }
      })
      .catch(() => setOllamaOk(false));
  }, []);

  const createFromTemplate = async (templateId: string): Promise<void> => {
    setBusy(true);
    setError("");
    try {
      if (ollamaOk && model && !localStorage.getItem("openbotWizardProvider")) {
        const existing = await api.bootstrap();
        if (!existing.providers.some((p) => p.name === "Ollama (로컬)")) {
          await api.createProvider({ name: "Ollama (로컬)", kind: "openai-compatible", baseUrl: "http://localhost:11434/v1", model, isDefault: true });
          localStorage.setItem("openbotWizardProvider", "1");
        }
      }
      const r = await api.createFromTemplate(templateId);
      onDone(r.conversationId);
    } catch (e) {
      setError(`생성 실패: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const createCustom = async (useOllama: boolean): Promise<void> => {
    setBusy(true);
    setError("");
    try {
      if (useOllama && model) {
        const existing = await api.bootstrap();
        if (!existing.providers.some((p) => p.name === "Ollama (로컬)")) {
          await api.createProvider({ name: "Ollama (로컬)", kind: "openai-compatible", baseUrl: "http://localhost:11434/v1", model, isDefault: true });
        }
      }
      const bot = await api.createBot({ name: name.trim() || "첫 봇", persona: persona.trim() || undefined });
      await api.sendMessage(bot.conversationId, "안녕! 너는 뭘 할 수 있어? 간단히 소개해줘.").catch(() => undefined);
      onDone(bot.conversationId);
    } catch (e) {
      setError(`생성 실패: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="wizard-backdrop">
      <div className="wizard" style={{ maxWidth: 620 }}>
        <div className="brand" style={{ marginBottom: 8 }}>OpenBot <span className="muted small">시작하기</span></div>

        {step === 1 && (
          <>
            <h3 style={{ marginTop: 0 }}>이 봇으로 무엇을 할까요?</h3>
            <p className="muted small">템플릿을 고르면 페르소나·루틴·첫 대화가 자동으로 설정됩니다.</p>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 12 }}>
              {templates.map((t) => (
                <button key={t.id} className="template-card" disabled={busy} onClick={() => void createFromTemplate(t.id)}>
                  <div style={{ fontSize: 28 }}>{t.icon}</div>
                  <div style={{ fontWeight: 700, fontSize: 14 }}>{t.title}</div>
                  <div className="muted" style={{ fontSize: 11.5, lineHeight: 1.4 }}>{t.description}</div>
                  {t.routines.length > 0 && <span className="badge ok" style={{ marginTop: 4 }}>⏰ 루틴 포함</span>}
                </button>
              ))}
            </div>
            {error && <p className="small" style={{ color: "#f87171" }}>{error}</p>}
            <div style={{ marginTop: 14, textAlign: "center" }}>
              <button className="btn" onClick={() => setStep(2)}>직접 만들기 →</button>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <h3 style={{ marginTop: 0 }}>첫 봇의 이름을 지어주세요</h3>
            <input autoFocus placeholder="예: 수호, 리서처, 코딩 파트너" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && name.trim() && setStep(3)} />
            <textarea rows={2} placeholder="성격/역할 (선택)" value={persona} onChange={(e) => setPersona(e.target.value)} />
            <div className="row" style={{ justifyContent: "space-between" }}>
              <button className="btn" onClick={() => setStep(1)}>← 템플릿으로</button>
              <button className="btn primary" disabled={!name.trim()} onClick={() => setStep(3)}>다음 →</button>
            </div>
          </>
        )}

        {step === 3 && (
          <>
            <h3 style={{ marginTop: 0 }}>어떤 모델로 대화할까요?</h3>
            {ollamaOk === null && <p className="muted">로컬 모델 확인 중…</p>}
            {ollamaOk === true && (
              <>
                <p className="muted small">이 머신의 Ollama를 발견했습니다 — 키 없이 로컬 모델을 씁니다.</p>
                <select value={model} onChange={(e) => setModel(e.target.value)}>
                  {models.map((m) => (
                    <option key={m.name} value={m.name}>{m.name}{m.capabilities?.includes("tools") ? " · tools" : ""}{m.capabilities?.includes("vision") ? " · vision" : ""}</option>
                  ))}
                </select>
              </>
            )}
            {ollamaOk === false && <p className="muted small">로컬 모델(Ollama)이 꺼져 있습니다 — 먼저 mock 봇으로 시작하고, 나중에 설정에서 모델을 연결할 수 있습니다.</p>}
            <div className="row" style={{ justifyContent: "space-between" }}>
              <button className="btn" onClick={() => setStep(2)}>← 이전</button>
              <button className="btn primary" disabled={busy} onClick={() => void createCustom(ollamaOk === true)}>
                {busy ? "만드는 중…" : "봇 만들고 첫 대화 시작 🚀"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
