import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CommandResult, ComputerProvider } from "./index.js";
import { DATA_DIR } from "../config.js";

/**
 * Trusted local execution with read confinement (deepseek-bot confined-runner
 * pattern): on macOS every command runs under sandbox-exec with a denylist —
 * the workspace stays writable but credential homes, the vault secret, the
 * database and backups are unreadable. Escape hatch: OPENBOT_DISABLE_SANDBOX=1.
 */

const HOME = os.homedir();
// all denies as regex — measured on darwin 25: subpath-based file-read* denies
// do not take effect while regex denies do (openbot.db subpath test failed,
// regex test passed; see matrix "terminal read confinement")
// realpath is required: sandbox-exec evaluates the RESOLVED path, so /var
// firmlinks (/var -> /private/var) never match a literal /var/... regex
// (measured — matrix tmpdir lived under /var/folders).
const RDATA = fs.realpathSync(DATA_DIR);
const DENY_PATH_PREFIXES = [
  path.join(HOME, ".ssh"),
  path.join(HOME, ".gnupg"),
  path.join(HOME, ".aws"),
  path.join(HOME, ".agents"),
  path.join(HOME, ".zcode"),
  path.join(HOME, ".codex"),
  path.join(HOME, ".kube"),
  path.join(RDATA, ".secret"),
  path.join(RDATA, "backups"),
  path.join(RDATA, "checkpoints"),
  path.join(RDATA, "openbot.db"),
];
const DENY_REGEX_SOURCES = DENY_PATH_PREFIXES.map((p) =>
  "^" + p.replace(/[.\\^$*+?()[\]{}|]/g, "\\$&") + "(-wal|-shm|/|$)"
);

let profilePath: string | null = null;

function ensureProfile(): string | null {
  if (process.platform !== "darwin") return null;
  if (process.env.OPENBOT_DISABLE_SANDBOX === "1") return null;
  if (profilePath && fs.existsSync(profilePath) && fs.existsSync(path.join(RDATA, "terminal-sandbox.sb")) === false) profilePath = null;
  if (profilePath && fs.existsSync(profilePath)) return profilePath;
  try {
    const lines = ["(version 1)", "(allow default)"];
    for (const src of DENY_REGEX_SOURCES) lines.push(`(deny file-read* (regex #"${src}"))`);
    profilePath = path.join(DATA_DIR, "terminal-sandbox.sb");
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(profilePath, lines.join("\n") + "\n");
    return profilePath;
  } catch {
    return null;
  }
}

export const localProvider: ComputerProvider = {
  kind: "local",
  async status() {
    const sb = ensureProfile();
    return { available: true, detail: sb ? `trusted local computer (read-confined: sandbox-exec denylist at ${sb})` : "trusted local computer (sandbox disabled)" };
  },
  run(_config, workspaceDir, command, timeoutMs) {
    return new Promise<CommandResult>((resolve) => {
      const sb = ensureProfile();
      const argv = sb ? ["/usr/bin/sandbox-exec", "-f", sb, "/bin/zsh", "-lc", command] : ["/bin/zsh", "-lc", command];
      const child = spawn(argv[0], argv.slice(1), {
        cwd: workspaceDir,
        env: {
          ...process.env,
          HOME,
          PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
        if (stdout.length > 1_000_000) child.kill("SIGKILL");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
        if (stderr.length > 1_000_000) child.kill("SIGKILL");
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ stdout, stderr, exitCode: code ?? (timedOut ? 124 : 1), timedOut });
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({ stdout, stderr: String(err), exitCode: 1 });
      });
    });
  },
};
