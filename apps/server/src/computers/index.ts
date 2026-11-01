import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { ComputerRow } from "../db.js";
import { COMPUTERS_DIR } from "../config.js";
import { localProvider } from "./local.js";
import { dockerProvider } from "./docker.js";
import { remoteExecProvider } from "./remote.js";

const execFileP = promisify(execFile);

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut?: boolean;
}

export interface ComputerProvider {
  kind: string;
  /** Cheap availability probe. Never throws. */
  status(): Promise<{ available: boolean; detail: string }>;
  /** Run a shell command inside the computer, rooted at the computer's workspace. */
  run(config: Record<string, unknown>, workspaceDir: string, command: string, timeoutMs: number): Promise<CommandResult>;
}

export const providers: Record<string, ComputerProvider> = {
  local: localProvider,
  docker: dockerProvider,
  // e2b/daytona expose REST sandboxes with an exec endpoint; createos/boat follow the same
  // remote-exec shape. All require credentials in their config; without them status()
  // reports unavailable with the exact missing key name.
  e2b: remoteExecProvider("e2b", "E2B_API_KEY"),
  daytona: remoteExecProvider("daytona", "DAYTONA_API_KEY"),
  createos: remoteExecProvider("createos", "CREATEOS_API_KEY"),
  boat: remoteExecProvider("boat", "BOAT_API_KEY"),
};

/** Resolve the local workspace directory backing a computer's files. */
export function workspaceFor(computer: ComputerRow, botId?: string | null): string {
  if (computer.kind === "team") {
    return path.join(COMPUTERS_DIR, `team-${computer.id}`);
  }
  const privId = botId ?? "default";
  return path.join(COMPUTERS_DIR, `private-${privId}`);
}

export function ensureWorkspace(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Execute a command against a computer, creating its workspace first. */
export async function runOnComputer(
  computer: ComputerRow,
  botId: string | null,
  command: string,
  timeoutMs = 60_000
): Promise<CommandResult> {
  const provider = providers[computer.provider];
  if (!provider) {
    return { stdout: "", stderr: `unknown computer provider '${computer.provider}'`, exitCode: 1 };
  }
  const ws = ensureWorkspace(workspaceFor(computer, botId));
  return provider.run(JSON.parse(computer.config || "{}"), ws, command, timeoutMs);
}

export async function providerStatus(kind: string): Promise<{ available: boolean; detail: string }> {
  const provider = providers[kind];
  if (!provider) return { available: false, detail: `unknown provider '${kind}'` };
  return provider.status();
}

export { execFileP };
