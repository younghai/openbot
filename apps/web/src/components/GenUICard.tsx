import React, { useMemo } from "react";
import { Renderer } from "@openuidev/react-lang";
import { openuiLibrary } from "@openuidev/react-ui/genui-lib";
import "@openuidev/react-ui/styles/index.css";

/**
 * Renders OpenUI Lang code as rich React components (charts, tables, cards).
 * Used inside ChatView when a bot calls the ui.render tool.
 */
export function GenUICard({ code }: { code: string }): JSX.Element {
  return (
    <div className="genui-card">
      <Renderer response={code} library={openuiLibrary} />
    </div>
  );
}
