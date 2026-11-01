import React, { useEffect, useState } from "react";
import { api } from "../api";
import type { Memory } from "../types";

export function MemoryPanel({ botId }: { botId: string }): JSX.Element {
  const [memories, setMemories] = useState<Memory[]>([]);
  const load = () => api.memories(botId).then(setMemories).catch(() => undefined);
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [botId]);
  return (
    <aside className="memory-panel">
      <h3>장기 메모리</h3>
      {memories.length === 0 && <p className="muted small">아직 저장된 메모리가 없습니다. 봇에게 "…기억해줘"라고 말해보세요.</p>}
      {memories.map((m) => (
        <div key={m.id} className="memory-item">
          <div>{m.content}</div>
          <button
            className="btn small danger"
            onClick={async () => {
              await api.deleteMemory(m.id);
              void load();
            }}
          >
            삭제
          </button>
        </div>
      ))}
    </aside>
  );
}
