import path from "node:path";
import { COMPUTERS_DIR, DATA_DIR } from "./config.js";

/**
 * Tool source catalog — data, not code paths. The ToolSources UI lists these
 * through GET /api/tool-catalog and registers one in a click. Entries were
 * live-verified keyless on 2026-10-30 (HTTP) or run locally via npx (stdio).
 */

export interface CatalogEntry {
  id: string;
  name: string;
  kind: "mcp";
  transport: "http" | "stdio";
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  description: string;
  requires: string;
}

export function catalogEntries(): CatalogEntry[] {
  return [
    {
      id: "context7",
      name: "Context7",
      kind: "mcp",
      transport: "http",
      url: "https://mcp.context7.com/mcp",
      description: "최신 라이브러리/프레임워크 공식 문서 검색. 봇이 구버전 API로 코딩하는 것을 막아준다.",
      requires: "키 불필요",
    },
    {
      id: "deepwiki",
      name: "DeepWiki",
      kind: "mcp",
      transport: "http",
      url: "https://mcp.deepwiki.com/mcp",
      description: "GitHub 저장소 위키 질의 — 저장소 구조·설계에 대한 문서를 봇이 읽게 한다.",
      requires: "키 불필요",
    },
    {
      id: "mcp-filesystem",
      name: "filesystem",
      kind: "mcp",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", COMPUTERS_DIR],
      description: `공식 reference 서버. 컴퓨터 워크스페이스(${path.join("data", "computers")})의 파일 읽기/쓰기/검색. 모든 컴퓨터 디렉터리에 접근한다(봇별 스코프는 2차).`,
      requires: "npx (로컬 실행)",
    },
    {
      id: "mcp-fetch",
      name: "fetch",
      kind: "mcp",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-fetch"],
      description: "공식 reference 서버. 웹 페이지를 가져와 마크다운으로 변환해 준다.",
      requires: "npx (로컬 실행)",
    },
    {
      id: "mcp-memory",
      name: "memory",
      kind: "mcp",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-memory"],
      env: { MEMORY_FILE_PATH: path.join(DATA_DIR, "mcp-memory.json") },
      description: "공식 reference 서버. 지식그래프 메모리(엔티티·관계). data/mcp-memory.json에 영속 저장.",
      requires: "npx (로컬 실행)",
    },
    {
      id: "mcp-sequential-thinking",
      name: "sequential-thinking",
      kind: "mcp",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
      description: "공식 reference 서버. 단계적 사고 도구 — 복잡한 추론 작업에서 봇의 중간 단계를 구조화한다.",
      requires: "npx (로컬 실행)",
    },
  ];
}

/** Config body the UI posts to /api/tool-sources for a catalog entry. */
export function catalogEntryConfig(entry: CatalogEntry): Record<string, unknown> {
  const cfg: Record<string, unknown> = { transport: entry.transport };
  if (entry.url) cfg.url = entry.url;
  if (entry.command) cfg.command = entry.command;
  if (entry.args) cfg.args = entry.args;
  if (entry.env) cfg.env = entry.env;
  return cfg;
}
