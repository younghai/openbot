import { spawn } from "node:child_process";
import type { CommandResult, ComputerProvider } from "./index.js";

/** Trusted local execution: the host machine is the computer. */
export const localProvider: ComputerProvider = {
  kind: "local",
  async status() {
    return { available: true, detail: "trusted local computer (this machine)" };
  },
  run(_config, workspaceDir, command, timeoutMs) {
    return new Promise<CommandResult>((resolve) => {
      const child = spawn("/bin/zsh", ["-lc", command], {
        cwd: workspaceDir,
        env: {
          ...process.env,
          HOME: process.env.HOME,
          // keep PATH predictable for GUI-launched processes
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
