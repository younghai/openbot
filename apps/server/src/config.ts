import fs from "node:fs";
import path from "node:path";

export const VERSION = "0.1.0";
export const PORT = Number(process.env.OPENBOT_PORT || 8940);

function repoRoot(): string {
  // server runs from apps/server; data lives at repo root /data
  const fromEnv = process.env.OPENBOT_DATA_DIR;
  if (fromEnv) return path.resolve(fromEnv);
  return path.resolve(process.cwd(), "../../data");
}

export const DATA_DIR = repoRoot();
export const DB_PATH = path.join(DATA_DIR, "openbot.db");
export const COMPUTERS_DIR = path.join(DATA_DIR, "computers");
export const SKILLS_DIR = path.join(DATA_DIR, "skills");
export const MEMORY_DIR = path.join(DATA_DIR, "memory");
export const MEDIA_DIR = path.join(DATA_DIR, "media");
export const SECRET_PATH = path.join(DATA_DIR, ".secret");

/**
 * 접근 토큰 (LAN/VPS 노출용). 설정하면 모든 /api와 WS가 Bearer 토큰을 요구한다.
 * 미설정 = 로컬 개방 (기본 바인딩 127.0.0.1이 이미 보호).
 */
export const AUTH_TOKEN = process.env.OPENBOT_AUTH_TOKEN?.trim() || "";

export function ensureDirs(): void {
  for (const dir of [DATA_DIR, COMPUTERS_DIR, SKILLS_DIR, MEDIA_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
}

/** Per-install secret used to encrypt stored credentials. Env override for server farms. */
export function getSecret(): string {
  if (process.env.OPENBOT_SECRET) return process.env.OPENBOT_SECRET;
  if (fs.existsSync(SECRET_PATH)) return fs.readFileSync(SECRET_PATH, "utf8").trim();
  const secret = crypto.randomUUID() + crypto.randomUUID();
  fs.writeFileSync(SECRET_PATH, secret, { mode: 0o600 });
  return secret;
}
