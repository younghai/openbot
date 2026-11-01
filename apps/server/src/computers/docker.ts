import { execFileP } from "./index.js";
import type { CommandResult, ComputerProvider } from "./index.js";

const DEFAULT_IMAGE = "ubuntu:24.04";

/**
 * Runs commands in an ephemeral Docker container with the computer workspace bind-mounted
 * at /workspace. Requires the docker CLI; status() reports exactly what is missing otherwise.
 */
export const dockerProvider: ComputerProvider = {
  kind: "docker",
  async status() {
    try {
      await execFileP("docker", ["version", "--format", "{{.Server.Version}}"], { timeout: 5000 });
      return { available: true, detail: "docker daemon reachable" };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const missing = msg.includes("ENOENT") || msg.includes("not found");
      return {
        available: false,
        detail: missing
          ? "docker CLI not installed on this machine"
          : `docker daemon not reachable: ${msg.split("\n")[0]}`,
      };
    }
  },
  async run(config, workspaceDir, command, timeoutMs) {
    const st = await this.status();
    if (!st.available) return { stdout: "", stderr: `computer unavailable: ${st.detail}`, exitCode: 125 };
    const image = typeof config.image === "string" ? config.image : DEFAULT_IMAGE;
    const inner = command.replace(/'/g, `'\\''`);
    try {
      const { stdout, stderr } = await execFileP(
        "docker",
        ["run", "--rm", "-v", `${workspaceDir}:/workspace`, "-w", "/workspace", image, "sh", "-c", inner],
        { timeout: timeoutMs, maxBuffer: 2_000_000 }
      );
      return { stdout, stderr, exitCode: 0 };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; code?: number; killed?: boolean };
      return {
        stdout: e.stdout ?? "",
        stderr: e.stderr ?? String(err),
        exitCode: e.killed ? 124 : (e.code ?? 1),
        timedOut: e.killed,
      };
    }
  },
};
