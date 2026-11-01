import path from "node:path";
import fsp from "node:fs/promises";
import { MEDIA_DIR } from "../config.js";
import { registerTool, assertPublicHttpUrl, type ToolContext } from "./gateway.js";

/**
 * Interactive browser control (rakazo-style embedded browser) via Playwright.
 * Playwright is an OPTIONAL dependency resolved at runtime through a dynamic,
 * non-literal import so the server compiles and boots without it. When absent,
 * every tool returns a precise install hint instead of crashing. One headless
 * page per computer (team computers share the page by design).
 */

interface PwLocator {
  first(): { click(opts?: unknown): Promise<void>; fill(value: string, opts?: unknown): Promise<void> };
}
interface PwPage {
  goto(url: string, opts?: unknown): Promise<unknown>;
  title(): Promise<string>;
  url(): string;
  isClosed(): boolean;
  evaluate(fn: () => string): Promise<string>;
  screenshot(opts: unknown): Promise<unknown>;
  getByText(text: string): PwLocator;
  locator(selector: string): PwLocator;
  waitForLoadState(opts?: unknown): Promise<void>;
  keyboard: { press(key: string): Promise<void> };
}
interface PwBrowser {
  close(): Promise<void>;
  newPage(opts?: unknown): Promise<PwPage>;
}
interface PlaywrightModule {
  chromium: { launch(opts?: unknown): Promise<PwBrowser> };
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
  browser: PwBrowser;
  page: PwPage;
  lastUsed: number;
}

const sessions = new Map<string, BrowserSession>();
const IDLE_CLOSE_MS = 5 * 60 * 1000;

function sessionKey(ctx: ToolContext): string {
  return ctx.computer.id;
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
  const browser = await pw.chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const session: BrowserSession = { browser, page, lastUsed: Date.now() };
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
  return { title, url: page.url(), text: text.slice(0, 6000) };
}

registerTool({
  name: "browser.open",
  description:
    "Open a page in the interactive headless browser (Playwright) and return title, visible text and a screenshot. Requires the optional playwright dependency; browser.fetch works without it.",
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
  description: "Close this computer's interactive browser session.",
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
