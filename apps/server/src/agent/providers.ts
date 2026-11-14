import type { ProviderRow } from "../db.js";
import { tryDecrypt } from "../crypto.js";

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface LlmMessage {
  role: "system" | "user" | "assistant" | "tool";
  /** plain text, or multimodal parts (text + images) for user messages */
  content: string | ContentPart[] | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}


/** Flatten message content to plain text (multimodal parts → text parts only). */
export function textContent(c: string | ContentPart[] | null | undefined): string {
  if (!c) return "";
  return Array.isArray(c) ? c.filter((p) => p.type === "text").map((p) => (p as { type: "text"; text: string }).text).join(" ") : c;
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ProviderResult {
  message: LlmMessage;
  model: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface ChatRequest {
  messages: LlmMessage[];
  tools: ToolDef[];
  temperature?: number;
  onDelta?: (text: string) => void;
  /** thinking-model support: called with the accumulated reasoning character count */
  onThinking?: (chars: number) => void;
}

export interface ModelProvider {
  chat(req: ChatRequest): Promise<ProviderResult>;
}

// ---------------------------------------------------------------- openai-compatible

class OpenAICompatProvider implements ModelProvider {
  constructor(private row: ProviderRow) {}

  async chat(req: ChatRequest): Promise<ProviderResult> {
    const base = (this.row.base_url || "https://api.openai.com/v1").replace(/\/$/, "");
    const apiKey = tryDecrypt(this.row.api_key_enc) ?? "";
    const tools = req.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
    const body: Record<string, unknown> = {
      model: this.row.model,
      messages: req.messages.map(toOpenAiMessage),
      temperature: req.temperature ?? 0.4,
      stream: true,
    };
    if (tools.length > 0) body.tools = tools;

    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream, application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`model provider HTTP ${res.status}: ${text.slice(0, 400)}`);
    }
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("text/event-stream")) {
      return parseCompletion(await res.json(), this.row.model);
    }
    return readChatStream(res, this.row.model, req.onDelta, req.onThinking);
  }
}

function parseCompletion(
  json: unknown,
  fallbackModel: string
): ProviderResult {
  const j = json as {
    choices?: { message?: { role: string; content: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
    model?: string;
  };
  const msg = j.choices?.[0]?.message;
  if (!msg) throw new Error("model provider returned no choices");
  return {
    message: {
      role: "assistant",
      content: msg.content ?? null,
      tool_calls: msg.tool_calls?.map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        args: safeJson(tc.function.arguments),
      })),
    },
    model: j.model ?? fallbackModel,
    usage: { inputTokens: j.usage?.prompt_tokens, outputTokens: j.usage?.completion_tokens },
  };
}

interface ToolCallAcc {
  id: string;
  name: string;
  argsText: string;
}

/**
 * SSE chat-completions stream: content deltas go to onDelta as they arrive;
 * tool_calls arrive as fragments keyed by index and are stitched here.
 * Reasoning/thinking fields some local models emit are ignored on purpose.
 */
async function readChatStream(
  res: Response,
  fallbackModel: string,
  onDelta?: (t: string) => void,
  onThinking?: (chars: number) => void
): Promise<ProviderResult> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let model = fallbackModel;
  let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;
  let reasoningChars = 0;
  let lastThinkingEmit = 0;
  const toolAcc = new Map<number, ToolCallAcc>();

  const handleEvent = (obj: Record<string, unknown>): void => {
    if (typeof obj.model === "string" && obj.model) model = obj.model;
    const u = obj.usage as typeof usage | undefined;
    if (u && (u.prompt_tokens !== undefined || u.completion_tokens !== undefined)) usage = u;
    const choice = (obj.choices as { delta?: { content?: string | null; reasoning?: string; reasoning_content?: string; thinking?: string; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] } }[] | undefined)?.[0];
    if (!choice) return;
    const reasoning = choice.delta?.reasoning ?? choice.delta?.reasoning_content ?? choice.delta?.thinking;
    if (typeof reasoning === "string" && reasoning) {
      reasoningChars += reasoning.length;
      if (onThinking && (reasoningChars - lastThinkingEmit >= 80 || reasoningChars < 80)) {
        lastThinkingEmit = reasoningChars;
        onThinking(reasoningChars);
      }
    }
    const piece = choice.delta?.content;
    if (typeof piece === "string" && piece) {
      content += piece;
      onDelta?.(piece);
    }
    for (const tc of choice.delta?.tool_calls ?? []) {
      const idx = tc.index ?? 0;
      const acc = toolAcc.get(idx) ?? { id: "", name: "", argsText: "" };
      if (tc.id) acc.id = tc.id;
      if (tc.function?.name) acc.name += tc.function.name;
      if (tc.function?.arguments) acc.argsText += tc.function.arguments;
      toolAcc.set(idx, acc);
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, "");
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        try {
          handleEvent(JSON.parse(data) as Record<string, unknown>);
        } catch {
          // keep scanning on non-JSON keepalives
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  const calls = [...toolAcc.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, acc]) => ({
      id: acc.id || `call_${crypto.randomUUID()}`,
      name: acc.name,
      args: safeJson(acc.argsText),
    }))
    .filter((c) => c.name);
  return {
    message: { role: "assistant", content: content || null, tool_calls: calls.length ? calls : undefined },
    model,
    usage: { inputTokens: usage?.prompt_tokens, outputTokens: usage?.completion_tokens },
  };
}

function toOpenAiMessage(m: LlmMessage): Record<string, unknown> {
  // multimodal user content (text + image_url parts) passes through as-is
  const content = Array.isArray(m.content) ? m.content : m.content ?? "";
  const out: Record<string, unknown> = { role: m.role, content };
  if (m.tool_calls) {
    out.tool_calls = m.tool_calls.map((tc) => ({
      id: tc.id,
      type: "function",
      function: { name: tc.name, arguments: JSON.stringify(tc.args ?? {}) },
    }));
  }
  if (m.role === "tool") {
    out.tool_call_id = m.tool_call_id;
    out.content = m.content ?? "";
  }
  return out;
}

function safeJson(s: string | undefined): Record<string, unknown> {
  if (!s) return {};
  try {
    const parsed = JSON.parse(s);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : { value: parsed };
  } catch {
    return { _raw: s };
  }
}

// ---------------------------------------------------------------- anthropic

class AnthropicProvider implements ModelProvider {
  constructor(private row: ProviderRow) {}

  async chat(req: ChatRequest): Promise<ProviderResult> {
    const base = (this.row.base_url || "https://api.anthropic.com/v1").replace(/\/$/, "");
    const apiKey = tryDecrypt(this.row.api_key_enc) ?? "";
    const system = req.messages.filter((m) => m.role === "system").map((m) => m.content ?? "").join("\n\n");
    const rest = req.messages.filter((m) => m.role !== "system");
    const body: Record<string, unknown> = {
      model: this.row.model,
      max_tokens: 4096,
      system,
      messages: rest.map(toAnthropicMessage),
    };
    if (req.tools.length > 0) {
      body.tools = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
    }
    const res = await fetch(`${base}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`anthropic HTTP ${res.status}: ${text.slice(0, 400)}`);
    }
    const json = (await res.json()) as {
      content: { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }[];
      usage?: { input_tokens?: number; output_tokens?: number };
      model?: string;
    };
    const text = json.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
    const toolCalls = json.content
      .filter((b) => b.type === "tool_use")
      .map((b) => ({ id: b.id ?? crypto.randomUUID(), name: b.name ?? "", args: b.input ?? {} }));
    return {
      message: { role: "assistant", content: text || null, tool_calls: toolCalls.length ? toolCalls : undefined },
      model: json.model ?? this.row.model,
      usage: { inputTokens: json.usage?.input_tokens, outputTokens: json.usage?.output_tokens },
    };
  }
}

function toAnthropicMessage(m: LlmMessage): Record<string, unknown> {
  if (m.role === "assistant") {
    const blocks: Record<string, unknown>[] = [];
    if (m.content) blocks.push({ type: "text", text: m.content });
    for (const tc of m.tool_calls ?? []) {
      blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.args });
    }
    if (blocks.length === 0) blocks.push({ type: "text", text: "" });
    return { role: "assistant", content: blocks };
  }
  if (m.role === "tool") {
    return {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: m.tool_call_id, content: [{ type: "text", text: m.content ?? "" }] },
      ],
    };
  }
  return { role: m.role, content: m.content ?? "" };
}

// ---------------------------------------------------------------- mock (no key needed; proves the full loop)

class MockProvider implements ModelProvider {
  async chat(req: ChatRequest): Promise<ProviderResult> {
    const textOf = (m: { content: string | ContentPart[] | null } | undefined): string => {
      if (!m) return "";
      return Array.isArray(m.content)
        ? m.content.filter((p) => p.type === "text").map((p) => (p as { type: "text"; text: string }).text).join(" ")
        : m.content ?? "";
    };
    const lastUser = [...req.messages].reverse().find((m) => m.role === "user");
    const lastTool = [...req.messages].reverse().find((m) => m.role === "tool");
    const lastAssistant = [...req.messages].reverse().find((m) => m.role === "assistant");

    // second round after a tool result: report and finish
    if (lastTool && lastAssistant?.tool_calls) {
      const toolNames = lastAssistant.tool_calls.map((t) => t.name).join(", ");
      let digest = (lastTool.content ?? "").slice(0, 300);
      try {
        const parsed = JSON.parse(textContent(lastTool.content) || "{}") as Record<string, unknown>;
        const parts: string[] = [];
        for (const key of ["exitCode", "status", "title", "bytes", "count", "matches", "saved", "preview", "stdout", "text", "result", "error"]) {
          if (parsed[key] !== undefined) parts.push(`${key}: ${String(JSON.stringify(parsed[key])).replace(/\\n/g, " ⏎ ").slice(0, 180)}`);
        }
        digest = parts.join("\n") || digest;
      } catch {
        /* keep raw slice */
      }
      const text = `[mock] 도구 ${toolNames} 실행 완료\n${digest}\n\n이어서 도움이 필요하면 말씀해 주세요.`;
      await streamOut(text, req.onDelta);
      return { message: { role: "assistant", content: text }, model: "mock-1" };
    }

    const text = textOf(lastUser).toLowerCase();
    const calls: ToolCall[] = [];
    const push = (name: string, args: Record<string, unknown>) =>
      calls.push({ id: `mock_${name}_${calls.length}`, name, args });

    if (/\bremember\b|기억해/.test(text)) {
      push("memory.save", { content: textOf(lastUser) });
    }
    const urlMatch = textContent(lastUser?.content).match(/https?:\/\/\S+/);
    if (/브라우저\s*열어|browser\s*open/.test(text)) {
      push("browser.open", { url: urlMatch?.[0] ?? "https://example.com" });
    } else if (/\bfetch\b|가져와|읽어와|url/.test(text) || urlMatch) {
      push("browser.fetch", { url: urlMatch?.[0] ?? "https://example.com" });
    }
    if (/\bterminal\b|\brun\b|명령|커맨드|셸|shell/.test(text)) {
      push("terminal.exec", { command: "pwd && echo hello from mock bot && date" });
    }
    if (/pycode/.test(text)) {
      push("python.exec", { code: 'x = 21\nprint("hello", x * 2)' });
    } else if (/pykeep/.test(text)) {
      push("python.exec", { code: 'print("kept:", x * 2)' });
    }
    if (/screenshot|스크린샷|화면 캡처/.test(text)) {
      push("desktop.screenshot", {});
    }
    if (/\bfile\b|파일.*(저장|만들|작성)/.test(text)) {
      push("fs.write", { path: "note.txt", content: "mock bot이 기록한 파일입니다." });
    }
    if (/\bdelegate\b|위임|에게.*물어|에게.*시켜/.test(text)) {
      const raw = textOf(lastUser);
      const at = raw.match(/@([A-Za-z가-힣0-9_-]+)/);
      const word = raw.replace(/delegate/gi, "").match(/\b([A-Z][A-Za-z0-9_-]*)\b/);
      push("bot.delegate", { task: raw, bot: (at ?? word)?.[1] });
    }
    if (/\bsubagent\b|서브에이전트/.test(text)) {
      push("subagent.run", { task: textOf(lastUser) });
    }
    if (/\bmcp\b|\bopenapi\b|\bapi\b.*tool/.test(text)) {
      push("skills.list", {});
    }
    if (/검색|\bsearch\b/.test(text)) {
      push("search.web", { query: textOf(lastUser).slice(0, 80) });
    }
    if (/pubmed|medical|biomedical/.test(text)) {
      push("pubmed.search", { query: "LLM clinical decision support", maxResults: 5 });
    } else if (/arxiv|paper|논문/.test(text)) {
      push("arxiv.search", { query: "LLM agent memory", maxResults: 5 });
    }
    if (/research report|보고서/.test(text)) {
      push("research.report", {
        researchQuestion: "What are the most effective memory architectures for LLM agents?",
        literature: "Chen et al. (2026) survey episodic/semantic/working memory. Park & Wang (2026) introduce ReMe.",
        hypothesis: "Markdown-based knowledge bases outperform vector-only RAG for personal recall.",
        experimentDesign: "Compare ReMe vs baseline RAG on 100 personal recall tasks.",
        findings: "ReMe achieved 34% improvement in recall accuracy.",
        conclusion: "Structured Markdown memory is superior for personal assistant contexts.",
        references: ["Chen et al. https://arxiv.org/abs/2601.12345", "Park & Wang https://arxiv.org/abs/2602.67890"],
      });
    }
    if (/long reply|긴 답변/.test(text)) {
      const big = ("프론트엔드 개발에서 상태 관리는 애플리케이션의 복잡성을 좌우하는 핵심 요소다.\n\n").repeat(120);
      await streamOut(big, req.onDelta);
      return { message: { role: "assistant", content: big }, model: "mock-1" };
    }
    if (/sandbox test|샌드박스/.test(text)) {
      push("terminal.exec", { command: 'cat "$OPENBOT_DATA_DIR/.secret"' });
    }
    if (/desktop apps|데스크톱 앱/.test(text)) {
      push("desktop.list_apps", {});
    }
    if (/desktop snapshot|데스크톱 스냩/.test(text)) {
      push("desktop.snapshot", { app: "Finder" });
    }
    const taskRef = /\[TASK\s+([A-Za-z0-9-]{6,36})\]/.exec(textOf(lastUser));
    if (taskRef) {
      push("task.update", { taskId: taskRef[1], status: "done", note: "mock 봇 작업 완료 처리" });
    }

    if (calls.length > 0) {
      return { message: { role: "assistant", content: null, tool_calls: calls }, model: "mock-1" };
    }
    const reply = `[mock:${textOf(lastUser).slice(0, 80)} 모델 키가 설정되지 않아 mock 응답입니다. 설정에서 모델 자격증명을 추가하면 실제 모델이 응답합니다. (도구 시연: "terminal 로 run 해줘", "https://example.com fetch 해줘", "이것 좀 remember 해줘")`;
    await streamOut(reply, req.onDelta);
    return { message: { role: "assistant", content: reply }, model: "mock-1" };
  }
}

async function streamOut(text: string, onDelta?: (t: string) => void): Promise<void> {
  if (!onDelta) return;
  for (const word of text.split(/(\s+)/)) {
    onDelta(word);
    await new Promise((r) => setTimeout(r, 12));
  }
}

// ---------------------------------------------------------------- registry

export function providerForRow(row: ProviderRow | undefined | null): ModelProvider {
  if (!row) return new MockProvider();
  switch (row.kind) {
    case "anthropic":
      return new AnthropicProvider(row);
    case "mock":
      return new MockProvider();
    default:
      return new OpenAICompatProvider(row);
  }
}
