import React, { useState } from "react";
import { api } from "../api";
import type { Bootstrap } from "../types";

export function Channels({
  boot,
  refresh,
  onOpen,
}: {
  boot: Bootstrap;
  refresh: () => void;
  onOpen: (conversationId: string) => void;
}): JSX.Element {
  const [title, setTitle] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const channels = boot.conversations.filter((c) => c.kind === "channel");

  return (
    <div className="page">
      <h2>공유 채널</h2>
      <p className="muted">여러 봇이 함께 참여하는 대화방입니다. 메시지를 보내면 모든 멤버 봇이 순서대로 답합니다.</p>

      <div className="card">
        <div className="form-grid">
          <label>채널 이름</label>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="예: 배포팀" />
          <label>멤버 봇</label>
          <div className="chips">
            {boot.bots.map((b) => (
              <button
                key={b.id}
                className={`chip ${selected.includes(b.id) ? "on" : ""}`}
                onClick={() => setSelected((s) => (s.includes(b.id) ? s.filter((x) => x !== b.id) : [...s, b.id]))}
              >
                {b.emoji} {b.name}
              </button>
            ))}
          </div>
        </div>
        <button
          className="btn primary"
          disabled={!title.trim() || selected.length === 0}
          onClick={async () => {
            const r = await api.createConversation({ kind: "channel", title, botIds: selected });
            setTitle("");
            setSelected([]);
            refresh();
            onOpen(r.id);
          }}
        >
          채널 만들기
        </button>
      </div>

      {channels.length === 0 && <p className="muted">채널이 없습니다.</p>}
      {channels.map((c) => (
        <ChannelCard key={c.id} channel={c} boot={boot} refresh={refresh} onOpen={onOpen} />
      ))}
    </div>
  );
}

function ChannelCard({
  channel,
  boot,
  refresh,
  onOpen,
}: {
  channel: Bootstrap["conversations"][number];
  boot: Bootstrap;
  refresh: () => void;
  onOpen: (id: string) => void;
}): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState<string[]>(
    boot.channelMembers.filter((m) => m.conversation_id === channel.id).map((m) => m.bot_id)
  );
  const members = boot.channelMembers.filter((m) => m.conversation_id === channel.id).map((m) => boot.bots.find((b) => b.id === m.bot_id));

  if (!editing) {
    return (
      <div className="card row">
        <div>
          <strong>#{channel.title}</strong>
          <span className="muted">{members.filter(Boolean).map((b) => `${b!.emoji} ${b!.name}`).join(" · ")}</span>
        </div>
        <div className="row">
          <button className="btn" onClick={() => setEditing(true)}>
            멤버 편집
          </button>
          <button className="btn" onClick={() => onOpen(channel.id)}>
            열기
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="card">
      <div>
        <strong>#{channel.title}</strong> 멤버 선택
      </div>
      <div className="chips">
        {boot.bots.map((b) => (
          <button
            key={b.id}
            className={`chip ${selected.includes(b.id) ? "on" : ""}`}
            onClick={() => setSelected((s) => (s.includes(b.id) ? s.filter((x) => x !== b.id) : [...s, b.id]))}
          >
            {b.emoji} {b.name}
          </button>
        ))}
      </div>
      <div className="row">
        <button
          className="btn primary"
          disabled={selected.length === 0}
          onClick={async () => {
            await api.patchChannelMembers(channel.id, selected);
            setEditing(false);
            refresh();
          }}
        >
          저장
        </button>
        <button className="btn" onClick={() => setEditing(false)}>
          취소
        </button>
      </div>
    </div>
  );
}
