import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { registerTool, retryHint } from "./gateway.js";
import { ensureWorkspace, workspaceFor } from "../computers/index.js";
import { ensureProfile } from "../computers/local.js";

/**
 * 상태 유지 Python 인터프리터 (code-interpreter 패턴): 봇별로 python3 -i 프로세스가
 * 유지되어 변수·함수·import가 호출 사이에 지속된다. terminal.exec과 같은
 * sandbox-exec 읽기 격리 프로파일 하에서 실행된다.
 *
 * 실행 프로토콜 (실측 프로토타입 v3): 다중 줄 래퍼는 REPL 파서가 망가뜨리므로
 * 실행은 항상 한 줄씩만 보낸다. 세션 시작 시 워크스페이스에 .openbot_runner.py를
 * 심고 import한다. 각 호출은 `__ob_run("<b64>", globals())` 한 줄 + 센티넬 print 한 줄.
 * 러너는 마지막 표현식을 print로 변환해 노트북처럼 에코한다 — exec()만으로는
 * 표현식이 조용히 사라져 모델이 결과를 환각하기 때문이다 (실측: 2550→2500 오답).
 */

const RUNNER_NAME = ".openbot_runner.py";
const RUNNER_SOURCE = [
  "import ast, base64, traceback",
  "def __ob_run(b64, g):",
  "    src = base64.b64decode(b64).decode()",
  "    try:",
  "        tree = ast.parse(src)",
  "        last = tree.body[-1] if tree.body else None",
  "        is_print = isinstance(last, ast.Expr) and isinstance(last.value, ast.Call) and isinstance(last.value.func, ast.Name) and last.value.func.id == 'print'",
  "        if isinstance(last, ast.Expr) and not is_print:",
  "            tree.body[-1] = ast.Expr(value=ast.Call(func=ast.Name(id='print', ctx=ast.Load()), args=[last.value], keywords=[]))",
  "            ast.fix_missing_locations(tree)",
  "        exec(compile(tree, '<openbot>', 'exec'), g)",
  "    except SystemExit:",
  "        raise",
  "    except BaseException:",
  "        traceback.print_exc()",
  "",
].join("\n");

const OUTPUT_CAP = 32_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const IDLE_KILL_MS = 15 * 60_000;
const MAX_SESSIONS = 16;

interface PySession {
  proc: ChildProcess;
  out: string;
  err: string;
  dead: boolean;
  nonce: string;
  lastUsed: number;
}

const sessions = new Map<string, PySession>();

// 유휴 세션 정리 (서버 종료를 막지 않음)
setInterval(() => {
  const now = Date.now();
  for (const [key, s] of sessions) {
    if (s.dead || now - s.lastUsed > IDLE_KILL_MS) {
      if (!s.dead) s.proc.kill("SIGKILL");
      sessions.delete(key);
    }
  }
}, 60_000).unref();

function pythonBin(): string {
  try {
    return execFileSync("which", ["python3"], { encoding: "utf8" }).trim() || "python3";
  } catch {
    return "python3";
  }
}

function stripPrompts(s: string): string {
  // REPL 프롬프트(>>> ...)가 stderr에 섞여 들어온다 — 라인 시작 토큰만 제거
  return s.replace(/^(?:>>> |\.\.\. )+/gm, "").trim();
}

function spawnSession(workspace: string): PySession {
  fs.writeFileSync(path.join(workspace, RUNNER_NAME), RUNNER_SOURCE, "utf8");
  const sb = ensureProfile();
  const py = pythonBin();
  const argv = sb ? ["/usr/bin/sandbox-exec", "-f", sb, py, "-i", "-q"] : [py, "-i", "-q"];
  const proc = spawn(argv[0], argv.slice(1), {
    cwd: workspace,
    env: {
      ...process.env,
      HOME: os.homedir(),
      PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
      PYTHONUNBUFFERED: "1",
      PYTHONDONTWRITEBYTECODE: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  proc.stdin?.write(`exec(open("${RUNNER_NAME}").read())\n`);
  const s: PySession = {
    proc,
    out: "",
    err: "",
    dead: false,
    nonce: Math.random().toString(36).slice(2, 10),
    lastUsed: Date.now(),
  };
  proc.stdout?.on("data", (c: Buffer) => { s.out += c.toString("utf8"); if (s.out.length > 4_000_000) s.out = s.out.slice(-2_000_000); });
  proc.stderr?.on("data", (c: Buffer) => { s.err += c.toString("utf8"); if (s.err.length > 1_000_000) s.err = s.err.slice(-500_000); });
  proc.on("close", () => { s.dead = true; });
  return s;
}

function killSession(key: string): void {
  const s = sessions.get(key);
  if (s && !s.dead) s.proc.kill("SIGKILL");
  sessions.delete(key);
}

interface ExecOutcome {
  stdout: string;
  stderr: string;
  dead: boolean;
  timedOut: boolean;
}

function runInSession(s: PySession, code: string, timeoutMs: number): Promise<ExecOutcome> {
  return new Promise((resolve) => {
    const startOut = s.out.length;
    const startErr = s.err.length;
    const b64 = Buffer.from(code, "utf8").toString("base64");
    const sentinel = `__OB__${s.nonce}`;
    const timer = setTimeout(() => {
      s.proc.kill("SIGKILL");
      resolve({ stdout: s.out.slice(startOut), stderr: s.err.slice(startErr), dead: true, timedOut: true });
    }, timeoutMs);
    const poll = setInterval(() => {
      const chunk = s.out.slice(startOut);
      if (chunk.includes(sentinel)) {
        clearInterval(poll);
        clearTimeout(timer);
        resolve({ stdout: chunk.split(sentinel)[0], stderr: s.err.slice(startErr), dead: false, timedOut: false });
      } else if (s.dead) {
        clearInterval(poll);
        clearTimeout(timer);
        resolve({ stdout: s.out.slice(startOut), stderr: s.err.slice(startErr), dead: true, timedOut: false });
      }
    }, 20);
    s.proc.stdin?.write(`__ob_run("${b64}", globals())\n`);
    s.proc.stdin?.write(`print("${sentinel}")\n`);
  });
}

registerTool({
  name: "python.exec",
  description:
    "Python 인터프리터에서 코드를 실행합니다. 같은 봇의 세션에서는 변수·함수·import가 호출 사이에 유지됩니다(대화형 노트북처럼). " +
    "코드의 마지막 표현식 값은 자동으로 출력됩니다(예: `total, avg` 한 줄이면 두 값이 출력됨). " +
    "데이터 분석·계산·텍스트 처리에 사용하고, 결과 차트·표는 ui.render로 시각화하세요. 워크스페이스 파일을 읽고 쓸 수 있습니다.",
  parameters: {
    type: "object",
    properties: {
      code: { type: "string", description: "Python code to execute (multi-line allowed)" },
      timeout_seconds: { type: "number", description: "timeout in seconds (default 30, max 120)" },
    },
    required: ["code"],
  },
  async execute(ctx, args) {
    const code = String(args.code ?? "");
    if (!code.trim()) throw new Error("code must not be empty");
    if (code.length > 100_000) throw new Error("code too long (max 100k chars)");
    const timeoutMs = Math.min(Math.max(Number(args.timeout_seconds ?? 30) * 1000 || DEFAULT_TIMEOUT_MS, 1000), MAX_TIMEOUT_MS);

    const key = ctx.bot.id;
    const workspace = ensureWorkspace(workspaceFor(ctx.computer, ctx.bot.id));
    const existing = sessions.get(key);
    let s: PySession;
    const sessionNew = !existing || existing.dead;
    if (!existing || existing.dead) {
      if (existing) killSession(key);
      if (sessions.size >= MAX_SESSIONS) {
        // 가장 오래 안 쓴 세션 제거 (LRU)
        let oldest: string | null = null;
        for (const [k, v] of sessions) if (!oldest || v.lastUsed < (sessions.get(oldest)?.lastUsed ?? 0)) oldest = k;
        if (oldest) killSession(oldest);
      }
      s = spawnSession(workspace);
      sessions.set(key, s);
    } else {
      s = existing;
    }
    s.lastUsed = Date.now();

    const result = await runInSession(s, code, timeoutMs);
    if (result.timedOut || result.dead) killSession(key);

    const stdout = result.stdout.slice(0, OUTPUT_CAP);
    const stderr = stripPrompts(result.stderr).slice(0, OUTPUT_CAP);
    const errored = /Traceback \(most recent call last\)/.test(result.stderr);
    return {
      stdout,
      ...(stderr ? { stderr } : {}),
      errored,
      session: result.timedOut || result.dead ? "lost" : sessionNew ? "new" : "kept",
      ...(result.timedOut
        ? { timedOut: true, hint: retryHint("TIMEOUT", "unsafe", "세션이 종료되었습니다 — 무한루프 의심, 반복 범위를 줄이세요") }
        : {}),
      ...(errored && !result.timedOut
        ? { hint: "Python 오류가 stderr에 있습니다. traceback을 읽고 수정한 코드로 다시 실행하세요. 세션 상태는 유지됩니다." }
        : {}),
      preview: (stdout || stderr || "(no output)").slice(0, 2000),
    };
  },
});
