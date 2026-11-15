import React, { useEffect, useRef, useState } from "react";
import { subscribe, sendWs } from "../ws";

/**
 * 🖥️ 라이브 브라우저 패널 (CK Computer panel 패턴):
 * - 봇의 브라우저 화면을 WS로 스트리밍해 본다 (jpeg ~1.25fps)
 * - 제어권 이관 중(takeover)이면 클릭·입력을 그대로 프록시하고, 반납 버튼이 생긴다
 * - 평소에는 보기만 가능 (봇에게 조작 요청은 채팅으로)
 */

const VIEW_W = 1280;
const VIEW_H = 800;

export function LiveBrowserPanel({ computerId, botId, botName, onClose }: { computerId: string; botId: string; botName: string; onClose: () => void }): JSX.Element {
  const [frame, setFrame] = useState<string | null>(null);
  const [takeover, setTakeover] = useState(false);
  const [note, setNote] = useState("");
  const imgRef = useRef<HTMLImageElement | null>(null);

  useEffect(() => {
    sendWs({ type: "browser.watch", computerId, botId });
    return subscribe((ev) => {
      const e = ev as Record<string, unknown>;
      if (e.type === "browser.frame" && e.computerId === computerId && e.botId === botId) setFrame(String(e.frame));
      else if (e.type === "takeover.started" && e.computerId === computerId && e.botId === botId) { setTakeover(true); setNote("사람이 조작 중 — 클릭·입력이 봇 브라우저로 전달됩니다"); }
      else if (e.type === "takeover.ended" && e.computerId === computerId && e.botId === botId) { setTakeover(false); setNote(""); }
      else if (e.type === "browser.act.result" && !e.ok) setNote(String(e.error ?? "조작 실패"));
    });
  }, [computerId, botId]);

  useEffect(() => () => sendWs({ type: "browser.unwatch" }), []);

  const sendCoords = (kind: "click", ev: React.MouseEvent<HTMLImageElement>): void => {
    const img = imgRef.current;
    if (!img) return;
    const rect = img.getBoundingClientRect();
    const x = Math.round(((ev.clientX - rect.left) / rect.width) * VIEW_W);
    const y = Math.round(((ev.clientY - rect.top) / rect.height) * VIEW_H);
    sendWs({ type: "browser.act", computerId, botId, action: { kind, x, y } });
  };

  return (
    <div className="live-browser-panel">
      <div className="row" style={{ justifyContent: "space-between", padding: "4px 8px", borderBottom: "1px solid var(--border)" }}>
        <span className="small"><strong>🖥️ {botName}</strong> 라이브 브라우저 <span className="muted">{frame ? "· 연결됨" : "· 대기 중 (봇이 browser.open을 호출하면 시작)"}</span></span>
        <div className="row">
          {takeover && (
            <button className="btn small primary" onClick={async () => {
              await fetch("/api/browser/release", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ computerId, botId }) });
              setNote("반납했습니다 — 봇이 이어서 진행합니다");
            }}>반납</button>
          )}
          <button className="btn small" onClick={onClose}>닫기</button>
        </div>
      </div>
      {note && <div className="small" style={{ padding: "4px 10px", color: takeover ? "var(--warn, #fbbf24)" : "var(--muted)" }}>{note}</div>}
      <div style={{ position: "relative", background: "#000", minHeight: 200 }}>
        {frame
          ? <img ref={imgRef} src={frame} alt="live browser" style={{ width: "100%", display: "block", cursor: takeover ? "crosshair" : "not-allowed" }} onClick={(e) => takeover && sendCoords("click", e)} />
          : <div className="muted small" style={{ padding: 40, textAlign: "center" }}>봇이 브라우저를 열면 여기에 화면이 표시됩니다</div>}
        {!takeover && frame && <div className="muted" style={{ position: "absolute", bottom: 6, left: 10, fontSize: 11 }}>보기 전용 — 봇에게 "제어권 넘겨줘"라고 하면 조작 가능</div>}
      </div>
    </div>
  );
}
