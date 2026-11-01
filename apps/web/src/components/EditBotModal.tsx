import React, { useState } from "react";
import { api } from "../api";
import type { Bot, Bootstrap } from "../types";

export function EditBotModal({
  boot,
  bot,
  onClose,
  refresh,
}: {
  boot: Bootstrap;
  bot: Bot;
  onClose: () => void;
  refresh: () => void;
}): JSX.Element {
  const [name, setName] = useState(bot.name);
  const [emoji, setEmoji] = useState(bot.emoji);
  const [persona, setPersona] = useState(bot.persona);
  const [providerId, setProviderId] = useState(bot.provider_id ?? "");
  const [computerId, setComputerId] = useState(bot.computer_id ?? "");
  const [tts, setTts] = useState<string>(bot.tts_provider);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>봇 편집 — {bot.name}</h3>
        <div className="form-grid">
          <label>이름</label>
          <input value={name} onChange={(e) => setName(e.target.value)} />
          <label>이모지</label>
          <input value={emoji} onChange={(e) => setEmoji(e.target.value)} className="emoji-input" />
          <label>페르소나</label>
          <textarea rows={4} value={persona} onChange={(e) => setPersona(e.target.value)} />
          <label>모델</label>
          <select value={providerId} onChange={(e) => setProviderId(e.target.value)}>
            <option value="">없음 (mock)</option>
            {boot.providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.model}){p.is_default ? " ★" : ""}
              </option>
            ))}
          </select>
          <label>컴퓨터</label>
          <select value={computerId} onChange={(e) => setComputerId(e.target.value)}>
            <option value="">기본 (Team Computer)</option>
            {boot.computers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.kind})
              </option>
            ))}
          </select>
          <label>음성</label>
          <select value={tts} onChange={(e) => setTts(e.target.value)}>
            <option value="browser">브라우저 (키 불필요)</option>
            <option value="elevenlabs">ElevenLabs</option>
            <option value="openai">OpenAI</option>
            <option value="cartesia">Cartesia</option>
            <option value="fish">Fish Audio</option>
          </select>
        </div>
        <div className="row" style={{ justifyContent: "space-between", marginTop: 14 }}>
          <div className="row">
            {!confirmDelete ? (
              <button className="btn danger" onClick={() => setConfirmDelete(true)}>
                봇 삭제…
              </button>
            ) : (
              <button
                className="btn danger"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await api.deleteBot(bot.id);
                    refresh();
                    onClose();
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                정말 삭제 (대화·메모리·루틴 함께 삭제)
              </button>
            )}
          </div>
          <div className="row">
            <button className="btn" onClick={onClose}>
              취소
            </button>
            <button
              className="btn primary"
              disabled={!name.trim() || busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await api.patchBot(bot.id, {
                    name,
                    emoji,
                    persona,
                    providerId: providerId || null,
                    computerId: computerId || null,
                    ttsProvider: tts,
                  });
                  refresh();
                  onClose();
                } finally {
                  setBusy(false);
                }
              }}
            >
              저장
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
