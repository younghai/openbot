import type { Context, Next } from "hono";
import { timingSafeEqual } from "node:crypto";
import { AUTH_TOKEN } from "./config.js";

/**
 * 접근 토큰 인증. OPENBOT_AUTH_TOKEN이 설정된 경우 모든 /api/* (health 제외)와
 * WS 업그레이드가 `Authorization: Bearer <token>` (또는 WS는 ?token=)을 요구한다.
 * 토큰이 없는 로컬 실행은 완전 개방 — 기본 바인딩이 127.0.0.1이므로 안전하다.
 */

export const AUTH_ENABLED = AUTH_TOKEN.length > 0;

/** 상수시간 토큰 비교 (타이밍 누출 방지) */
function tokenOk(presented: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(AUTH_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function extractToken(header: string | undefined): string {
  if (!header) return "";
  const m = header.match(/^Bearer\s+(.+)$/i);
  return (m?.[1] ?? "").trim();
}

/** /api 미들웨어 — health는 liveness 프로브를 위해 개방.
 * ?token= 쿼리 폴백은 <img>/<video> 태그가 헤더를 못 실을 때 필요 (미디어·파일 뷰어). */
export async function requireAuth(c: Context, next: Next): Promise<Response | void> {
  if (!AUTH_ENABLED || c.req.path === "/api/health") return next();
  const presented =
    extractToken(c.req.header("authorization")) ||
    c.req.header("x-openbot-token") ||
    c.req.query("token") ||
    "";
  if (!presented || !tokenOk(presented)) {
    return c.json({ error: "unauthorized" }, 401);
  }
  return next();
}

/** WS 업그레이드 검사 — ?token= 파라미터 */
export function wsTokenOk(url: string | undefined): boolean {
  if (!AUTH_ENABLED) return true;
  try {
    const token = new URL(url ?? "", "http://x").searchParams.get("token") ?? "";
    return token.length > 0 && tokenOk(token);
  } catch {
    return false;
  }
}
