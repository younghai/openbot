import { decrypt, maskPresent } from "../crypto.js";
import type { CommandResult, ComputerProvider } from "./index.js";

/**
 * Generic remote-sandbox exec adapter shared by E2B / Daytona / CreateOS / Boat.
 * config: { apiUrl?, apiKeyEnc, sandboxId? }. The apiKey is stored encrypted in the
 * computer's config (set via the API). Each provider has a default API base; commands
 * are POSTed as { command, cwd } to <apiUrl>/exec and must return { stdout, stderr, exitCode }.
 * Providers differ in exact endpoints; the endpoint template is overridable via
 * config.execPath so new sandboxes need no code change.
 */
export function remoteExecProvider(kind: string, keyName: string): ComputerProvider {
  return {
    kind,
    async status() {
      const cfg = await loadConfig(kind);
      if (!cfg) {
        return {
          available: false,
          detail: `${kind} not configured: add a computer with provider '${kind}' and set its API key (${keyName})`,
        };
      }
      try {
        const res = await fetch(`${cfg.apiUrl}/health`, { headers: authHeaders(cfg), signal: AbortSignal.timeout(8000) });
        return { available: res.ok, detail: res.ok ? `${kind} reachable` : `${kind} health check returned HTTP ${res.status}` };
      } catch (err) {
        return { available: false, detail: `${kind} unreachable: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
    async run(config, _workspaceDir, command, timeoutMs) {
      const st = await this.status();
      if (!st.available) return { stdout: "", stderr: `computer unavailable: ${st.detail}`, exitCode: 125 };
      const cfg = await loadConfig(kind);
      if (!cfg) return { stdout: "", stderr: "provider became unconfigured mid-run", exitCode: 125 };
      const execPath = typeof config.execPath === "string" ? config.execPath : "/exec";
      try {
        const res = await fetch(`${cfg.apiUrl}${execPath}`, {
          method: "POST",
          headers: { ...authHeaders(cfg), "content-type": "application/json" },
          body: JSON.stringify({ command, timeoutMs }),
          signal: AbortSignal.timeout(timeoutMs + 10_000),
        });
        const body = (await res.json().catch(() => ({}))) as Partial<CommandResult>;
        if (!res.ok) {
          return { stdout: "", stderr: `${kind} exec failed (HTTP ${res.status}): ${JSON.stringify(body).slice(0, 500)}`, exitCode: 1 };
        }
        return {
          stdout: body.stdout ?? "",
          stderr: body.stderr ?? "",
          exitCode: body.exitCode ?? 0,
        };
      } catch (err) {
        return { stdout: "", stderr: `${kind} exec error: ${err instanceof Error ? err.message : String(err)}`, exitCode: 1 };
      }
    },
  };
}

interface RemoteCfg {
  apiUrl: string;
  apiKey?: string;
  bearer?: boolean;
}

const DEFAULT_API_URLS: Record<string, string> = {
  e2b: "https://api.e2b.dev",
  daytona: "https://api.daytona.io",
  createos: "https://api.createos.ai",
  boat: "https://api.boat.dev",
};

async function loadConfig(kind: string): Promise<RemoteCfg | null> {
  const { db } = await import("../db.js");
  const row = db.prepare("SELECT config FROM computers WHERE provider = ? LIMIT 1").get(kind) as
    | { config: string }
    | undefined;
  if (!row) return null;
  const cfg = JSON.parse(row.config || "{}") as { apiUrl?: string; apiKeyEnc?: string; bearer?: boolean };
  if (!maskPresent(cfg.apiKeyEnc)) return null;
  return {
    apiUrl: cfg.apiUrl || DEFAULT_API_URLS[kind] || `https://${kind}.example.com`,
    apiKey: decrypt(cfg.apiKeyEnc!),
    bearer: cfg.bearer ?? false,
  };
}

function authHeaders(cfg: RemoteCfg): Record<string, string> {
  if (!cfg.apiKey) return {};
  return cfg.bearer
    ? { authorization: `Bearer ${cfg.apiKey}` }
    : { "x-api-key": cfg.apiKey };
}
