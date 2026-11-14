import React from "react";
import { Renderer } from "@openuidev/react-lang";
import { openuiLibrary } from "@openuidev/react-ui/genui-lib";
import "@openuidev/react-ui/styles/index.css";

/** OpenUI 액션 이벤트 (open_url / continue_conversation / custom) — @openuidev/lang-core ActionEvent 계약 */
export interface UiActionEvent {
  type: string;
  params: Record<string, unknown>;
  humanFriendlyMessage?: string;
  formState?: Record<string, unknown>;
  formName?: string;
}

/**
 * Renders OpenUI Lang code as rich React components (charts, tables, cards).
 * Used inside ChatView when a bot calls the ui.render tool.
 * onAction이 있으면 폼 제출·버튼 클릭이 대화로 되돌아간다 (human-in-the-loop).
 */
export function GenUICard({ code, onAction }: { code: string; onAction?: (event: UiActionEvent) => void }): JSX.Element {
  return (
    <div className="genui-card">
      <Renderer response={code} library={openuiLibrary} onAction={onAction} />
    </div>
  );
}
