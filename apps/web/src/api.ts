import type { Approval, AuditRow, Bootstrap, BotTemplate, CatalogEntry, Checkpoint, FileEntry, Job, Memory, Message, ModelPreset, NotificationRow, PolicyPreset, PresetModel, SearchResults, Stats, Task, TtsProvider, UsageCap } from "./types";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok && !(res.status === 503 && path.includes("/test"))) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

export const api = {
  bootstrap: () => req<Bootstrap>("/bootstrap"),

  createBot: (body: { name: string; emoji?: string; persona?: string; providerId?: string; computerId?: string; ttsProvider?: string }) =>
    req<{ id: string; conversationId: string }>("/bots", { method: "POST", body: JSON.stringify(body) }),
  patchBot: (id: string, body: Record<string, unknown>) =>
    req<{ ok: boolean }>(`/bots/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteBot: (id: string) => req<{ ok: boolean }>(`/bots/${id}`, { method: "DELETE" }),
  memories: (botId: string) => req<Memory[]>(`/bots/${botId}/memories`),
  deleteMemory: (id: string) => req<{ ok: boolean }>(`/memories/${id}`, { method: "DELETE" }),

  createConversation: (body: { kind: "dm"; botId: string } | { kind: "channel"; title: string; botIds: string[] }) =>
    req<{ id: string }>("/conversations", { method: "POST", body: JSON.stringify(body) }),
  patchChannelMembers: (id: string, botIds: string[]) =>
    req<{ ok: boolean; members: number }>(`/conversations/${id}/members`, { method: "PATCH", body: JSON.stringify({ botIds }) }),
  messages: (conversationId: string) => req<Message[]>(`/conversations/${conversationId}/messages`),
  sendMessage: (conversationId: string, content: string, attachments?: { path: string; name?: string; contentType?: string }[]) =>
    req<{ jobId: string }>(`/conversations/${conversationId}/messages`, { method: "POST", body: JSON.stringify({ content, attachments }) }),
  uploadAttachment: async (file: File): Promise<{ path: string; url: string; name: string; size: number; contentType: string }> => {
    const form = new FormData();
    form.append("file", file);
    const res = await fetch("/api/media/attachments", { method: "POST", body: form });
    const body = (await res.json().catch(() => ({}))) as { path?: string; error?: string };
    if (!res.ok || !body.path) throw new Error(body.error ?? `HTTP ${res.status}`);
    return body as { path: string; url: string; name: string; size: number; contentType: string };
  },
  policyPresets: () => req<{ presets: PolicyPreset[]; current: string }>("/tool-policies/presets"),
  applyPolicyPreset: (id: string) => req<{ ok: boolean; applied?: string; error?: string }>(`/tool-policies/presets/${id}/apply`, { method: "POST" }),

  tasks: () => req<Task[]>("/tasks"),
  createTask: (body: { title: string; detail?: string; assigneeBotId?: string; dueAt?: number }) =>
    req<{ id: string }>("/tasks", { method: "POST", body: JSON.stringify(body) }),
  patchTask: (id: string, body: Record<string, unknown>) => req<{ ok: boolean }>(`/tasks/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteTask: (id: string) => req<{ ok: boolean }>(`/tasks/${id}`, { method: "DELETE" }),
  runTask: (id: string) => req<{ jobId: string; conversationId: string }>(`/tasks/${id}/run`, { method: "POST" }),

  search: (q: string) => req<SearchResults>(`/search?q=${encodeURIComponent(q)}`),
  stats: () => req<Stats>("/stats"),
  notifications: (unread = false) => req<NotificationRow[]>(`/notifications${unread ? "?unread=1" : ""}`),
  markNotificationsRead: () => req<{ ok: boolean; marked: number }>("/notifications/read-all", { method: "POST" }),
  knowledgeDocs: (botId: string) => req<{ documents: { source: string; chunks: number }[] }>(`/knowledge?botId=${botId}`),
  indexKnowledge: (botId: string, path: string) => req<{ chunks: number }>("/knowledge/index", { method: "POST", body: JSON.stringify({ botId, path }) }),
  channelStatus: () => req<Record<string, boolean>>("/channel-status"),
  botTemplates: () => req<BotTemplate[]>("/bot-templates"),
  createFromTemplate: (templateId: string, name?: string) =>
    req<{ id: string; conversationId: string; name: string; routines: number }>(`/bot-templates/${templateId}/create`, { method: "POST", body: JSON.stringify({ name }) }),
  exportTeam: async (): Promise<string> => {
    const res = await fetch("/api/teams/export");
    return res.text();
  },
  importTeam: (markdown: string, dryRun = false) =>
    req<{ preview?: unknown; imported?: { bots: number; channels: number; routines: number } }>("/teams/import", { method: "POST", body: JSON.stringify({ markdown, dryRun }) }),
  duplicateBot: (id: string) => req<{ id: string; name: string; conversationId: string }>(`/bots/${id}/duplicate`, { method: "POST" }),
  usageCaps: () => req<UsageCap[]>("/usage-caps"),
  putUsageCap: (botId: string, body: { dailyTokenCap?: number; monthlyTokenCap?: number; enabled?: boolean }) =>
    req<{ ok: boolean }>(`/usage-caps/${botId}`, { method: "PUT", body: JSON.stringify(body) }),
  backup: () => req<{ ok: boolean; file: string; bytes: number }>("/backup", { method: "POST" }),
  files: (scope: "memory" | "workspace", computerId?: string, botId?: string, path?: string) =>
    req<{ path: string; entries: FileEntry[] }>(`/files?scope=${scope}${computerId ? `&computerId=${computerId}` : ""}${botId ? `&botId=${botId}` : ""}${path ? `&path=${encodeURIComponent(path)}` : ""}`),
  fileContent: (scope: "memory" | "workspace", path: string, computerId?: string, botId?: string) =>
    req<{ path: string; content: string }>(`/files/content?scope=${scope}&path=${encodeURIComponent(path)}${computerId ? `&computerId=${computerId}` : ""}${botId ? `&botId=${botId}` : ""}`),
  fileContentUrl: (scope: "memory" | "workspace", path: string, computerId?: string, botId?: string) =>
    `/api/files/content?scope=${scope}&path=${encodeURIComponent(path)}${computerId ? `&computerId=${computerId}` : ""}${botId ? `&botId=${botId}` : ""}`,
  saveFile: (body: { scope: "memory" | "workspace"; path: string; content: string; computerId?: string; botId?: string }) =>
    req<{ ok: boolean }>("/files/content", { method: "PUT", body: JSON.stringify(body) }),
  checkpoints: () => req<Checkpoint[]>("/checkpoints"),
  restoreCheckpoint: (id: string) => req<{ ok: boolean; error?: string }>(`/checkpoints/${id}/restore`, { method: "POST" }),
  deleteCheckpoint: (id: string) => req<{ ok: boolean }>(`/checkpoints/${id}`, { method: "DELETE" }),

  messagesBefore: (conversationId: string, before: number) =>
    req<Message[]>(`/conversations/${conversationId}/messages?before=${before}&limit=60`),

  jobs: () => req<Job[]>("/queue"),
  cancelJob: (id: string) => req<{ ok: boolean }>(`/queue/${id}/cancel`, { method: "POST" }),
  approvals: (status?: string) => req<Approval[]>(`/approvals${status ? `?status=${status}` : ""}`),
  approveTool: (id: string) => req<{ ok: boolean; error?: string }>(`/approvals/${id}/approve`, { method: "POST" }),
  denyTool: (id: string) => req<{ ok: boolean; error?: string }>(`/approvals/${id}/deny`, { method: "POST" }),
  audit: (limit = 200) => req<AuditRow[]>(`/audit?limit=${limit}`),

  computerProviders: () => req<Record<string, { available: boolean; detail: string }>>("/computer-providers"),
  createComputer: (body: Record<string, unknown>) => req<{ id: string }>("/computers", { method: "POST", body: JSON.stringify(body) }),
  deleteComputer: (id: string) => req<{ ok: boolean }>(`/computers/${id}`, { method: "DELETE" }),
  testComputer: (id: string) => req<{ available: boolean; detail: string }>(`/computers/${id}/test`, { method: "POST" }),

  createProvider: (body: Record<string, unknown>) => req<{ id: string }>("/providers", { method: "POST", body: JSON.stringify(body) }),
  patchProvider: (id: string, body: Record<string, unknown>) => req<{ ok: boolean }>(`/providers/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteProvider: (id: string) => req<{ ok: boolean }>(`/providers/${id}`, { method: "DELETE" }),
  testProvider: (id: string) =>
    req<{ ok: boolean; model?: string; reply?: string; error?: string }>(`/providers/${id}/test`, { method: "POST" }),
  listPresets: () => req<ModelPreset[]>("/presets"),
  listPresetModels: (id: string) =>
    req<{ ok: boolean; models?: PresetModel[]; error?: string }>(`/presets/${id}/models`),

  createToolSource: (body: Record<string, unknown>) =>
    req<{ id: string; status: string; detail: string | null; tools: string[] }>("/tool-sources", { method: "POST", body: JSON.stringify(body) }),
  refreshToolSource: (id: string) => req<{ ok: boolean; count?: number; tools?: string[]; error?: string }>(`/tool-sources/${id}/refresh`, { method: "POST" }),
  deleteToolSource: (id: string) => req<{ ok: boolean }>(`/tool-sources/${id}`, { method: "DELETE" }),
  toolCatalog: () => req<CatalogEntry[]>("/tool-catalog"),

  createRoutine: (body: { botId: string; cron: string; prompt: string; name?: string }) =>
    req<{ id: string }>("/routines", { method: "POST", body: JSON.stringify(body) }),
  patchRoutine: (id: string, body: Record<string, unknown>) => req<{ ok: boolean }>(`/routines/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteRoutine: (id: string) => req<{ ok: boolean }>(`/routines/${id}`, { method: "DELETE" }),

  putCredential: (key: string, value: string) =>
    req<{ ok: boolean }>("/settings/credentials", { method: "PUT", body: JSON.stringify({ key, value }) }),

  /** TTS: returns server audio, or a signal to fall back to the browser speech synthesis. */
  tts: async (text: string, provider: TtsProvider): Promise<{ audio?: Blob; fallbackBrowser: boolean; error?: string }> => {
    const res = await fetch("/api/voice/tts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, provider }),
    });
    if (res.ok) return { audio: await res.blob(), fallbackBrowser: false };
    const body = (await res.json().catch(() => ({}))) as { error?: string; fallback?: string };
    return { fallbackBrowser: body.fallback === "browser", error: body.error ?? `HTTP ${res.status}` };
  },
};

export function mediaUrl(path: string): string {
  return `/api/media/${path.replace(/^\/?api\/media\/?/, "")}`;
}
