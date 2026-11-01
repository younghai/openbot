import { db, type ToolSourceRow } from "../db.js";
import { decrypt, maskPresent } from "../crypto.js";
import { mcpClientFor, dropMcpClient, stdioClientFor, dropStdioClient } from "../mcp.js";
import { parseOpenApi, executeOperation, type ApiOperation } from "../openapi.js";
import type { ToolDef } from "../agent/providers.js";

/**
 * Dynamic tool sources: remote MCP servers, OpenAPI specs, Composio, Pipedream Connect,
 * and Treg metered tools. Each enabled source contributes namespaced tools such as
 * `mcp.github.create_issue` or `api.pets.listPets` to every bot's toolset.
 */

const PREFIX_FOR_KIND: Record<string, string> = {
  mcp: "mcp",
  openapi: "api",
  composio: "composio",
  pipedream: "pd",
  treg: "treg",
};

interface SourceConfig {
  url?: string;
  specUrl?: string;
  spec?: string;
  baseUrl?: string;
  apiKeyEnc?: string;
  tokenEnc?: string;
  headerName?: string;
  authType?: "bearer" | "apiKey";
  execPath?: string;
  /** MCP only: "http" (default) or "stdio" for npx-style local servers */
  transport?: "http" | "stdio";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface DynamicTool extends ToolDef {
  sourceId: string;
  sourceKind: string;
}

const cache = new Map<string, { tools: DynamicTool[]; fetchedAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000;

function sourceConfig(row: ToolSourceRow): SourceConfig {
  return JSON.parse(row.config || "{}") as SourceConfig;
}

function slug(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_").toLowerCase();
}

function srcHeaders(cfg: SourceConfig): Record<string, string> {
  const token = maskPresent(cfg.apiKeyEnc ?? cfg.tokenEnc) ? decrypt((cfg.apiKeyEnc ?? cfg.tokenEnc)!) : undefined;
  if (!token) return {};
  if (cfg.authType === "bearer" || cfg.tokenEnc) return { authorization: `Bearer ${token}` };
  return { [cfg.headerName ?? "x-api-key"]: token };
}

/** List tools contributed by every enabled source. Cold sources populate via refreshSource. */
export function listDynamicTools(): DynamicTool[] {
  const sources = db.prepare("SELECT * FROM tool_sources WHERE enabled=1").all() as unknown as ToolSourceRow[];
  const out: DynamicTool[] = [];
  for (const src of sources) {
    const cached = cache.get(src.id);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      out.push(...cached.tools);
    }
  }
  return out;
}

export function cachedToolsFor(sourceId: string): DynamicTool[] {
  return cache.get(sourceId)?.tools ?? [];
}

/** Connect/verify a source, list its tools, cache them, persist status. Throws on failure. */
export async function refreshSource(sourceId: string): Promise<DynamicTool[]> {
  const row = db.prepare("SELECT * FROM tool_sources WHERE id=?").get(sourceId) as unknown as ToolSourceRow | undefined;
  if (!row) throw new Error("tool source not found");
  const cfg = sourceConfig(row);
  const prefix = PREFIX_FOR_KIND[row.kind] ?? row.kind;
  const ns = slug(row.name);
  let tools: DynamicTool[];
  try {
    tools = await fetchSourceTools(row, cfg, prefix, ns);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    db.prepare("UPDATE tool_sources SET status='error', status_detail=? WHERE id=?").run(detail.slice(0, 500), sourceId);
    throw err;
  }
  cache.set(sourceId, { tools, fetchedAt: Date.now() });
  db.prepare("UPDATE tool_sources SET status='ok', status_detail=? WHERE id=?").run(`${tools.length} tools`, sourceId);
  return tools;
}

async function fetchSourceTools(row: ToolSourceRow, cfg: SourceConfig, prefix: string, ns: string): Promise<DynamicTool[]> {
  switch (row.kind) {
    case "mcp": {
      if (cfg.transport === "stdio") {
        if (!cfg.command) throw new Error("stdio MCP source needs config.command (e.g. 'npx' with config.args)");
        const client = stdioClientFor(row.id, cfg.command, cfg.args ?? [], cfg.env ?? {});
        await client.connect();
        const tools = await client.listTools();
        return tools.map((t) => ({
          name: `${prefix}.${ns}.${t.name}`,
          description: t.description ?? `MCP tool ${t.name} (source: ${row.name})`,
          parameters: (t.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
          sourceId: row.id,
          sourceKind: row.kind,
        }));
      }
      if (!cfg.url) throw new Error("MCP source needs config.url (the MCP streamable-http endpoint)");
      const client = mcpClientFor(row.id, cfg.url, srcHeaders(cfg));
      await client.connect();
      const tools = await client.listTools();
      return tools.map((t) => ({
        name: `${prefix}.${ns}.${t.name}`,
        description: t.description ?? `MCP tool ${t.name} (source: ${row.name})`,
        parameters: (t.inputSchema as Record<string, unknown>) ?? { type: "object", properties: {} },
        sourceId: row.id,
        sourceKind: row.kind,
      }));
    }
    case "openapi": {
      let specText = cfg.spec;
      if (!specText && cfg.specUrl) {
        const res = await fetch(cfg.specUrl, { signal: AbortSignal.timeout(20_000) });
        if (!res.ok) throw new Error(`spec fetch HTTP ${res.status}`);
        specText = await res.text();
      }
      if (!specText) throw new Error("OpenAPI source needs config.spec (inline) or config.specUrl");
      const parsed = parseOpenApi(specText, cfg.baseUrl);
      return parsed.operations.map((op) => ({
        name: `${prefix}.${ns}.${op.name}`,
        description: `${op.description} [${op.method} ${op.path}]`,
        parameters: op.parameters,
        sourceId: row.id,
        sourceKind: row.kind,
      }));
    }
    case "composio": {
      const key = maskPresent(cfg.apiKeyEnc) ? decrypt(cfg.apiKeyEnc!) : undefined;
      if (!key) throw new Error("Composio source needs an API key (config.apiKeyEnc is set from the raw key via the API)");
      const res = await fetch("https://backend.composio.dev/api/v1/tools?limit=200", {
        headers: { "x-api-key": key },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`Composio HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const json = (await res.json()) as { items?: { name: string; description?: string; parameters?: Record<string, unknown> }[] };
      return (json.items ?? []).slice(0, 200).map((t) => ({
        name: `${prefix}.${ns}.${slug(t.name)}`,
        description: t.description ?? `Composio action ${t.name}`,
        parameters: t.parameters ?? { type: "object", properties: {} },
        sourceId: row.id,
        sourceKind: row.kind,
      }));
    }
    case "pipedream": {
      const key = maskPresent(cfg.apiKeyEnc) ? decrypt(cfg.apiKeyEnc!) : undefined;
      if (!key) throw new Error("Pipedream Connect source needs an API key");
      const res = await fetch("https://api.pipedream.com/v1/apps?page=1&limit=50", {
        headers: { authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`Pipedream HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const json = (await res.json()) as { data?: { name?: string; slug?: string; description?: string }[] };
      return (json.data ?? []).map((app) => ({
        name: `${prefix}.${ns}.${slug(app.name ?? app.slug ?? "app")}_actions`,
        description: `List connected actions for Pipedream app ${app.name ?? app.slug} (experimental: returns app actions)`,
        parameters: { type: "object", properties: {} },
        sourceId: row.id,
        sourceKind: row.kind,
      }));
    }
    case "treg": {
      if (!cfg.baseUrl) throw new Error("Treg source needs config.baseUrl (your Treg deployment endpoint)");
      const res = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/tools`, {
        headers: srcHeaders(cfg),
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) throw new Error(`Treg HTTP ${res.status}`);
      const json = (await res.json()) as { tools?: { name: string; description?: string; parameters?: Record<string, unknown> }[] };
      return (json.tools ?? []).map((t) => ({
        name: `${prefix}.${ns}.${slug(t.name)}`,
        description: t.description ?? `Treg tool ${t.name}`,
        parameters: t.parameters ?? { type: "object", properties: {} },
        sourceId: row.id,
        sourceKind: row.kind,
      }));
    }
    default:
      throw new Error(`unknown tool source kind '${row.kind}'`);
  }
}

/** Execute a namespaced dynamic tool. Returns tool output or throws. */
export async function dispatchDynamicTool(fullName: string, args: Record<string, unknown>): Promise<unknown> {
  const [prefix, ns, ...rest] = fullName.split(".");
  const toolName = rest.join(".");
  if (!prefix || !ns || !toolName) throw new Error(`malformed dynamic tool name '${fullName}'`);
  const kind = Object.entries(PREFIX_FOR_KIND).find(([, p]) => p === prefix)?.[0];
  if (!kind) throw new Error(`unknown tool prefix '${prefix}'`);
  const row = db.prepare("SELECT * FROM tool_sources WHERE kind=? AND enabled=1").all(kind) as unknown as ToolSourceRow[];
  const src = row.find((r) => slug(r.name) === ns);
  if (!src) throw new Error(`no enabled '${kind}' source named '${ns}'`);
  const cfg = sourceConfig(src);

  switch (kind) {
    case "mcp": {
      if (cfg.transport === "stdio") {
        const client = stdioClientFor(src.id, cfg.command!, cfg.args ?? [], cfg.env ?? {});
        await client.connect();
        return client.callTool(toolName, args);
      }
      const client = mcpClientFor(src.id, cfg.url!, srcHeaders(cfg));
      return client.callTool(toolName, args);
    }
    case "openapi": {
      let specText = cfg.spec;
      if (!specText && cfg.specUrl) specText = await (await fetch(cfg.specUrl)).text();
      const parsed = parseOpenApi(specText!, cfg.baseUrl);
      const op = parsed.operations.find((o) => o.name === toolName) as ApiOperation | undefined;
      if (!op) throw new Error(`operation '${toolName}' not found in spec`);
      const auth = maskPresent(cfg.apiKeyEnc)
        ? { type: (cfg.authType ?? "bearer") as "bearer" | "apiKey", token: decrypt(cfg.apiKeyEnc!), header: cfg.headerName }
        : undefined;
      return executeOperation(parsed.baseUrl, op, args, auth);
    }
    case "composio": {
      const key = decrypt(cfg.apiKeyEnc!)!;
      const res = await fetch("https://backend.composio.dev/api/v1/actions/execute", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": key },
        body: JSON.stringify({ action: toolName, params: args }),
        signal: AbortSignal.timeout(30_000),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`Composio execute HTTP ${res.status}: ${text.slice(0, 300)}`);
      return { raw: text.slice(0, 20_000) };
    }
    case "pipedream": {
      const key = decrypt(cfg.apiKeyEnc!)!;
      const res = await fetch("https://api.pipedream.com/v1/apps", {
        headers: { authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(30_000),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`Pipedream HTTP ${res.status}: ${text.slice(0, 300)}`);
      return { note: "Pipedream action execution requires a connected account; returning app listing", raw: text.slice(0, 8192) };
    }
    case "treg": {
      const res = await fetch(`${cfg.baseUrl!.replace(/\/$/, "")}/tools/${toolName}`, {
        method: "POST",
        headers: { ...srcHeaders(cfg), "content-type": "application/json" },
        body: JSON.stringify(args),
        signal: AbortSignal.timeout(30_000),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`Treg execute HTTP ${res.status}: ${text.slice(0, 300)}`);
      return { raw: text.slice(0, 20_000) };
    }
    default:
      throw new Error(`unhandled kind ${kind}`);
  }
}

export function invalidateSource(sourceId: string): void {
  cache.delete(sourceId);
  dropMcpClient(sourceId);
  dropStdioClient(sourceId);
}
