import path from "node:path";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { MEDIA_DIR, DATA_DIR } from "../config.js";
import { registerTool, assertPublicHttpUrl, type ToolContext } from "./gateway.js";

/**
 * Interactive browser control (rakazo-style embedded browser) via Playwright.
 * Playwright is an OPTIONAL dependency resolved at runtime through a dynamic,
 * non-literal import so the server compiles and boots without it. When absent,
 * every tool returns a precise install hint instead of crashing.
 *
 * CK/OpenBot computer-use 패턴 적용 (2026-11-15):
 * - 세션 영속: 봇별 userDataDir(브라우저 프로필) → 로그인·쿠키가 재부팅 후에도 유지
 * - 라이브 스트리밍: jpeg 프레임 펌프(ws.ts가 getSessionPage 사용)
 * - 제어권 이관: 사람의 직접 조작(page.mouse/keyboard 프록시) + 시크릿 직주입
 */

interface PwLocator {
  first(): { click(opts?: unknown): Promise<void>; fill(value: string, opts?: unknown): Promise<void> };
}
interface PwPage {
  goto(url: string, opts?: unknown): Promise<unknown>;
  title(): Promise<string>;
  url(): string;
  isClosed(): boolean;
  evaluate(fn: () => string | void): Promise<string | void>;
  screenshot(opts: unknown): Promise<unknown>;
  getByText(text: string): PwLocator;
  locator(selector: string): PwLocator;
  waitForLoadState(opts?: unknown): Promise<void>;
  keyboard: { press(key: string): Promise<void>; type(text: string): Promise<void> };
  mouse: { click(x: number, y: number, opts?: unknown): Promise<void>; move(x: number, y: number): Promise<void> };
  fill(selector: string, value: string, opts?: unknown): Promise<void>;
}
interface PwBrowser {
  close(): Promise<void>;
  newPage(opts?: unknown): Promise<PwPage>;
  contexts(): { pages(): PwPage[] }[];
}
interface PwPersistentContext extends PwBrowser {}
interface PlaywrightModule {
  chromium: {
    launch(opts?: unknown): Promise<PwBrowser>;
    launchPersistentContext(userDataDir: string, opts?: unknown): Promise<PwPersistentContext>;
  };
}

const INSTALL_HINT =
  "interactive browser needs Playwright: enable with `pnpm --filter @openbot/server add playwright && pnpm --filter @openbot/server exec playwright install chromium` (browser.fetch works without it)";

let pwPromise: Promise<PlaywrightModule | null> | null = null;

async function loadPlaywright(): Promise<PlaywrightModule | null> {
  if (!pwPromise) {
    // non-literal specifier keeps this an optional dependency at compile time
    const specifier = "playwright";
    pwPromise = import(specifier)
      .then((m) => m as PlaywrightModule)
      .catch(() => null);
  }
  return pwPromise;
}

interface BrowserSession {
  browser: PwPersistentContext | PwBrowser;
  page: PwPage;
  lastUsed: number;
  persistent: boolean;
}

const sessions = new Map<string, BrowserSession>();
const IDLE_CLOSE_MS = 10 * 60 * 1000;

/** 컴퓨터×봇 단위 키 — 봇마다 자기 브라우저 프로필을 가진다 (CK: per-bot profile). */
function sessionKey(ctx: ToolContext): string {
  return `${ctx.computer.id}:${ctx.bot.id}`;
}

function profileDir(ctx: ToolContext): string {
  const dir = path.join(DATA_DIR, "browser-profiles", ctx.computer.id, ctx.bot.id);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function getSession(ctx: ToolContext): Promise<BrowserSession> {
  const pw = await loadPlaywright();
  if (!pw) throw new Error(INSTALL_HINT);
  const key = sessionKey(ctx);
  const existing = sessions.get(key);
  if (existing && Date.now() - existing.lastUsed < IDLE_CLOSE_MS && !existing.page.isClosed()) {
    existing.lastUsed = Date.now();
    return existing;
  }
  if (existing) await closeSession(key).catch(() => undefined);
  // 영속 컨텍스트: 프로필 디스크에 저장 → 로그인·쿠키가 프로세스 재시작 후에도 남는다
  const browser = await pw.chromium.launchPersistentContext(profileDir(ctx), {
    headless: true,
    viewport: { width: 1280, height: 800 },
  });
  // persistent context는 그 자체가 BrowserContext — pages()에 기존 탭이 있다
  const anyCtx = browser as unknown as { pages?: () => PwPage[]; contexts?: () => { pages(): PwPage[] }[] };
  const pages = anyCtx.pages?.() ?? anyCtx.contexts?.()?.[0]?.pages?.() ?? [];
  const page = pages[0] ?? (await browser.newPage({ viewport: { width: 1280, height: 800 } }));
  const session: BrowserSession = { browser, page, lastUsed: Date.now(), persistent: true };
  sessions.set(key, session);
  return session;
}

async function closeSession(key: string): Promise<void> {
  const s = sessions.get(key);
  if (!s) return;
  sessions.delete(key);
  await s.browser.close().catch(() => undefined);
}

async function shoot(page: PwPage): Promise<string> {
  await fsp.mkdir(MEDIA_DIR, { recursive: true });
  const rel = `browser-${Date.now()}.png`;
  await page.screenshot({ path: path.join(MEDIA_DIR, rel), fullPage: false });
  return `/api/media/${rel}`;
}

async function pageDigest(page: PwPage): Promise<{ title: string; url: string; text: string }> {
  const title = await page.title().catch(() => "");
  const text = await page
    .evaluate(() => {
      const g = globalThis as unknown as { document?: { body?: { innerText?: string } } };
      return (g.document?.body?.innerText ?? "").replace(/\n{3,}/g, "\n\n");
    })
    .catch(() => "");
  return { title, url: page.url(), text: String(text ?? "").slice(0, 6000) };
}

registerTool({
  name: "browser.open",
  description:
    "Open a page in the interactive headless browser (Playwright) and return title, visible text and a screenshot. The browser keeps its profile per bot — logins and cookies persist across sessions. Requires the optional playwright dependency; browser.fetch works without it.",
  parameters: {
    type: "object",
    properties: { url: { type: "string", description: "http(s) URL to open" } },
    required: ["url"],
  },
  async execute(ctx, args) {
    const url = assertPublicHttpUrl(String(args.url ?? ""));
    const session = await getSession(ctx);
    await session.page.goto(url.href, { waitUntil: "domcontentloaded", timeout: 30_000 });
    const digest = await pageDigest(session.page);
    const screenshot = await shoot(session.page);
    return { ...digest, screenshot };
  },
});

registerTool({
  name: "browser.click",
  description: "Click an element in the interactive browser by visible text or CSS selector.",
  parameters: {
    type: "object",
    properties: {
      text: { type: "string", description: "visible text to click" },
      selector: { type: "string", description: "CSS selector (used when text is empty)" },
    },
  },
  async execute(ctx, args) {
    const session = await getSession(ctx);
    if (args.text) await session.page.getByText(String(args.text)).first().click({ timeout: 10_000 });
    else await session.page.locator(String(args.selector ?? "body")).first().click({ timeout: 10_000 });
    await session.page.waitForLoadState({ state: "domcontentloaded" }).catch(() => undefined);
    const digest = await pageDigest(session.page);
    return { clicked: String(args.text ?? args.selector), ...digest };
  },
});

registerTool({
  name: "browser.type",
  description: "Type text into a form field of the interactive browser (fill by CSS selector).",
  parameters: {
    type: "object",
    properties: {
      selector: { type: "string", description: "CSS selector of the input/textarea" },
      text: { type: "string", description: "text to type" },
      pressEnter: { type: "boolean", description: "press Enter after typing" },
    },
    required: ["selector", "text"],
  },
  async execute(ctx, args) {
    const session = await getSession(ctx);
    await session.page.locator(String(args.selector ?? "")).first().fill(String(args.text ?? ""), { timeout: 10_000 });
    if (args.pressEnter) await session.page.keyboard.press("Enter");
    const digest = await pageDigest(session.page);
    return { typed: true, ...digest };
  },
});

registerTool({
  name: "browser.snapshot",
  description: "Capture current interactive browser state: title, visible text and screenshot.",
  parameters: { type: "object", properties: {} },
  async execute(ctx) {
    const session = await getSession(ctx);
    const digest = await pageDigest(session.page);
    const screenshot = await shoot(session.page);
    return { ...digest, screenshot };
  },
});

registerTool({
  name: "browser.close",
  description: "Close this computer's interactive browser session. The profile (logins, cookies) stays on disk.",
  parameters: { type: "object", properties: {} },
  async execute(ctx) {
    await closeSession(sessionKey(ctx));
    return { closed: true };
  },
});

setInterval(() => {
  for (const [key, s] of sessions) {
    if (Date.now() - s.lastUsed > IDLE_CLOSE_MS) void closeSession(key);
  }
}, 60_000).unref();

// ---------------------------------------------------------------- 라이브 스트리밍 + 제어권 (ws.ts가 사용)

/** 스트리밍·조작이 같은 세션을 쓰도록 노출. 봇이 세션을 닫아도 다시 만든다. */
export async function sessionForStream(ctx: ToolContext): Promise<PwPage | null> {
  try {
    const s = await getSession(ctx);
    return s.page;
  } catch {
    return null; // playwright 미설치 등 — 스트리밍은 조용히 포기
  }
}

export async function findSessionPage(computerId: string, botId: string): Promise<PwPage | null> {
  const s = sessions.get(`${computerId}:${botId}`);
  return s && !s.page.isClosed() ? s.page : null;
}

/** 사람의 직접 조작(제어권 이관) — 좌표 클릭·타이핑·키. 봇 페이지에 프록시한다. */
export async function proxyAction(computerId: string, botId: string, action: { kind: "click" | "type" | "key"; x?: number; y?: number; text?: string; selector?: string }): Promise<{ ok: boolean; error?: string }> {
  const page = await findSessionPage(computerId, botId);
  if (!page) return { ok: false, error: "열려 있는 브라우저 세션이 없습니다 — 봇이 먼저 browser.open을 호출해야 합니다" };
  try {
    if (action.kind === "click") await page.mouse.click(Number(action.x ?? 0), Number(action.y ?? 0));
    else if (action.kind === "type" && action.selector) await page.fill(action.selector, String(action.text ?? ""));
    else if (action.kind === "type") await page.keyboard.type(String(action.text ?? ""));
    else if (action.kind === "key") await page.keyboard.press(String(action.text ?? "Enter"));
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 시크릿 직주입 (CK computer_request_secret 패턴): 값은 이 함수 안에서만 존재, 봇에게는 절대 반환되지 않는다. */
export async function injectSecret(computerId: string, botId: string, selector: string, secret: string): Promise<{ ok: boolean; error?: string }> {
  const page = await findSessionPage(computerId, botId);
  if (!page) return { ok: false, error: "열려 있는 브라우저 세션이 없습니다" };
  try {
    await page.fill(selector, secret, { timeout: 10_000 });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** jpeg 프레임 캡처 (라이브 패널용 — 품질 55, 빠른 폴링용) */
export async function frameJpeg(computerId: string, botId: string): Promise<Buffer | null> {
  const page = await findSessionPage(computerId, botId);
  if (!page) return null;
  try {
    const buf = await page.screenshot({ type: "jpeg", quality: 55, fullPage: false });
    return buf as Buffer;
  } catch {
    return null;
  }
}
