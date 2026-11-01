import React, { useEffect, useState } from "react";
import { api } from "../api";
import type { PresetModel } from "../types";

/** 첫 실행 온보딩: 봇 이름 → 로컬 모델 자동 감지 → 첫 질문 자동 발사. */
export function Wizard({ onDone }: { onDone: (conversationId: string) => void }): JSX.Element {
  const [step, setStep] = useState(1);
  const [name, setName] = useState("");
  const [persona, setPersona] = useState("");
  const [ollamaOk, setOllamaOk] = useState<boolean | null>(null);
  const [models, setModels] = useState<PresetModel[]>([]);
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
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

  const finish = async (useOllama: boolean): Promise<void> => {
    setBusy(true);
    try {
      if (useOllama && model) {
        const existing = await api.bootstrap();
        const dup = existing.providers.find((p) => p.name === "Ollama (로컬)");
        if (!dup) {
          await api.createProvider({ name: "Ollama (로컬)", kind: "openai-compatible", baseUrl: "http://localhost:11434/v1", model, isDefault: true });
        }
      }
      const bot = await api.createBot({ name: name.trim() || "첫 봇", persona: persona.trim() || undefined });
      await api.sendMessage(bot.conversationId, "안녕! 너는 뭘 할 수 있어? 간단히 소개해줘.").catch(() => undefined);
      onDone(bot.conversationId);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="wizard-backdrop">
      <div className="wizard">
        <div className="brand" style={{ marginBottom: 10 }}>OpenBot <span className="muted small">시작하기</span></div>
        {step === 1 && (
          <>
            <h3 style={{ marginTop: 0 }}>첫 봇의 이름을 지어주세요</h3>
            <input autoFocus placeholder="예: 수호, 리서처, 코딩 파트너" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && name.trim() && setStep(2)} />
            <textarea rows={2} placeholder="성격/역할 (선택) — 예: 뉴스를 짧게 요약해주는 봇" value={persona} onChange={(e) => setPersona(e.target.value)} />
            <div className="row" style={{ justifyContent: "flex-end" }}>
              <button className="btn primary" disabled={!name.trim()} onClick={() => setStep(2)}>다음 →</button>
            </div>
          </>
        )}
        {step === 2 && (
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
              <button className="btn" onClick={() => setStep(1)}>← 이전</button>
              <button className="btn primary" disabled={busy} onClick={() => void finish(ollamaOk === true)}>
                {busy ? "만드는 중…" : "봇 만들고 첫 대화 시작 🚀"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
