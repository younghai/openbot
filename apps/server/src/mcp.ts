/**
 * Minimal MCP (Model Context Protocol) client over the Streamable HTTP transport.
 * JSON-RPC 2.0 POSTs; server may answer with JSON or an SSE stream of JSON-RPC
 * messages. Session id comes from the Mcp-Session-Id response header.
 *
 * McpStdioClient below speaks the stdio transport instead (newline-delimited
 * JSON-RPC over a child process's stdin/stdout) — the transport the official
 * reference servers (filesystem, fetch, memory, …) use when launched via npx.
 */

import { spawn, type ChildProcess } from "node:child_process";

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export class McpClient {
  private nextId = 1;
  private sessionId: string | null = null;

  constructor(
    private url: string,
    private headers: Record<string, string> = {}
  ) {}

  private async rpc(method: string, params?: unknown, notify = false): Promise<unknown> {
    const body: Record<string, unknown> = { jsonrpc: "2.0", method };
    if (!notify) body.id = this.nextId++;
    if (params !== undefined) body.params = params;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...this.headers,
    };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
    const res = await fetch(this.url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    const sessionHeader = res.headers.get("mcp-session-id");
    if (sessionHeader) this.sessionId = sessionHeader;
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`MCP server HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    if (notify) return undefined;
    const contentType = res.headers.get("content-type") ?? "";
    const payload = contentType.includes("text/event-stream")
      ? await readSseResponse(res, body.id as number)
      : ((await res.json()) as Record<string, unknown>);
    if (payload.error) {
      throw new Error(`MCP error ${JSON.stringify(payload.error).slice(0, 300)}`);
    }
    return payload.result;
  }

  async connect(): Promise<void> {
    const result = (await this.rpc("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "openbot", version: "0.1.0" },
    })) as { serverInfo?: { name?: string; version?: string } } | undefined;
    await this.rpc("notifications/initialized", undefined, true).catch(() => undefined);
    if (!result) throw new Error("MCP initialize returned no result");
  }

  async listTools(): Promise<McpTool[]> {
    const result = (await this.rpc("tools/list", {})) as { tools?: McpTool[] } | undefined;
    return result?.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const result = (await this.rpc("tools/call", { name, arguments: args })) as
      | { content?: { type: string; text?: string }[]; isError?: boolean }
      | undefined;
    if (!result) throw new Error("MCP tools/call returned no result");
    const text = (result.content ?? [])
      .map((c) => (c.type === "text" ? (c.text ?? "") : `(${c.type})`))
      .join("\n");
    if (result.isError) throw new Error(`MCP tool error: ${text.slice(0, 500)}`);
    return { text: text.slice(0, 20_000) };
  }
}

async function readSseResponse(res: Response, id: number): Promise<Record<string, unknown>> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, "");
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data) continue;
        try {
          const parsed = JSON.parse(data) as Record<string, unknown>;
          if (parsed.id === id) return parsed;
        } catch {
          // keep scanning on non-JSON keepalives
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  throw new Error("MCP SSE stream ended before a result arrived");
}

/** Cache of connected MCP clients per tool source. */
const clients = new Map<string, McpClient>();

export function mcpClientFor(sourceId: string, url: string, headers: Record<string, string>): McpClient {
  let client = clients.get(sourceId);
  if (!client) {
    client = new McpClient(url, headers);
    clients.set(sourceId, client);
  }
  return client;
}

export function dropMcpClient(sourceId: string): void {
  clients.delete(sourceId);
}

// ---------------------------------------------------------------- stdio transport

const RPC_TIMEOUT_MS = 60_000; // first npx run downloads the package before answering

export class McpStdioClient {
  private proc: ChildProcess | null = null;
  private nextId = 1;
  private buffer = "";
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private startPromise: Promise<void> | null = null;

  constructor(
    private command: string,
    private args: string[],
    private env: Record<string, string> = {}
  ) {}

  private ensureProc(): ChildProcess {
    if (this.proc && this.proc.exitCode === null && !this.proc.killed) return this.proc;
    const proc = spawn(this.command, this.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...this.env },
    });
    this.proc = proc;
    this.buffer = "";
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => this.onChunk(chunk));
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", () => undefined); // drain so the child never blocks on stderr
    proc.on("exit", () => {
      this.startPromise = null; // a later call respawns and re-initializes
      const err = new Error("MCP stdio server exited");
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    });
    return proc;
  }

  private onChunk(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, nl).replace(/\r$/, "");
      this.buffer = this.buffer.slice(nl + 1);
      if (!line.trim()) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue; // non-JSON noise on stdout
      }
      if (typeof msg.id !== "number") continue; // notifications
      const p = this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`MCP error ${JSON.stringify(msg.error).slice(0, 300)}`));
      else p.resolve(msg.result);
    }
  }

  private rpc(method: string, params?: unknown, notify = false): Promise<unknown> {
    const proc = this.ensureProc();
    const body: Record<string, unknown> = { jsonrpc: "2.0", method };
    if (!notify) body.id = this.nextId++;
    if (params !== undefined) body.params = params;
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      if (!notify) {
        const id = body.id as number;
        timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`MCP stdio rpc '${method}' timed out after ${RPC_TIMEOUT_MS / 1000}s [TIMEOUT · 재시도 판단 필요 — 조회성 요청은 안전, 변경성 요청은 위험]`));
        }, RPC_TIMEOUT_MS);
        this.pending.set(id, {
          resolve: (v) => { clearTimeout(timer); resolve(v); },
          reject: (e) => { clearTimeout(timer); reject(e); },
        });
      }
      proc.stdin!.write(JSON.stringify(body) + "\n", (err) => {
        if (err) {
          if (timer) clearTimeout(timer);
          if (!notify) this.pending.delete(body.id as number);
          reject(err);
        }
      });
      if (notify) resolve(undefined);
    });
  }

  async connect(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    this.startPromise = (async () => {
      const result = (await this.rpc("initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "openbot", version: "0.1.0" },
      })) as { serverInfo?: { name?: string; version?: string } } | undefined;
      await this.rpc("notifications/initialized", undefined, true).catch(() => undefined);
      if (!result) throw new Error("MCP stdio initialize returned no result");
    })().catch((err: unknown) => {
      this.startPromise = null;
      throw err;
    });
    return this.startPromise;
  }

  async listTools(): Promise<McpTool[]> {
    const result = (await this.rpc("tools/list", {})) as { tools?: McpTool[] } | undefined;
    return result?.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const result = (await this.rpc("tools/call", { name, arguments: args })) as
      | { content?: { type: string; text?: string }[]; isError?: boolean }
      | undefined;
    if (!result) throw new Error("MCP tools/call returned no result");
    const text = (result.content ?? [])
      .map((c) => (c.type === "text" ? (c.text ?? "") : `(${c.type})`))
      .join("\n");
    if (result.isError) throw new Error(`MCP tool error: ${text.slice(0, 500)}`);
    return { text: text.slice(0, 20_000) };
  }

  kill(): void {
    this.startPromise = null;
    if (this.proc && !this.proc.killed) this.proc.kill();
    this.proc = null;
  }
}

const stdioClients = new Map<string, McpStdioClient>();

export function stdioClientFor(
  sourceId: string,
  command: string,
  args: string[],
  env: Record<string, string>
): McpStdioClient {
  let client = stdioClients.get(sourceId);
  if (!client) {
    client = new McpStdioClient(command, args, env);
    stdioClients.set(sourceId, client);
  }
  return client;
}

export function dropStdioClient(sourceId: string): void {
  stdioClients.get(sourceId)?.kill();
  stdioClients.delete(sourceId);
}

// never leave child processes behind when the server stops
process.on("exit", () => {
  for (const c of stdioClients.values()) c.kill();
});
