export interface Bot {
  id: string;
  name: string;
  emoji: string;
  persona: string;
  provider_id: string | null;
  computer_id: string | null;
  tts_provider: TtsProvider;
  status: "active" | "paused";
  pinned?: number;
  hidden?: number;
  created_at: number;
}

export type TtsProvider = "browser" | "elevenlabs" | "openai" | "cartesia" | "fish";

export interface Conversation {
  id: string;
  kind: "dm" | "channel";
  title: string | null;
  bot_id: string | null;
  created_at: number;
}

export interface ChannelMember {
  conversation_id: string;
  bot_id: string;
}

export interface ComputerStatus {
  available: boolean;
  detail: string;
}

export interface Computer {
  id: string;
  name: string;
  kind: "team" | "private";
  provider: string;
  config: Record<string, unknown>;
  created_at: number;
  status: ComputerStatus;
}

export interface ModelProvider {
  id: string;
  name: string;
  kind: "openai-compatible" | "anthropic" | "mock";
  base_url: string | null;
  model: string;
  is_default: number;
  hasKey: boolean;
  created_at: number;
}

export interface ModelPreset {
  id: string;
  name: string;
  kind: "openai-compatible" | "anthropic" | "mock";
  baseUrl: string | null;
  requiresKey: boolean;
  discover: string | null;
  note: string;
}

export interface PresetModel {
  name: string;
  capabilities?: string[];
}

export interface CatalogEntry {
  id: string;
  name: string;
  kind: "mcp";
  transport: "http" | "stdio";
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  description: string;
  requires: string;
}

export interface ToolSource {
  id: string;
  name: string;
  kind: "mcp" | "openapi" | "composio" | "pipedream" | "treg";
  config: Record<string, unknown>;
  enabled: number;
  status: string;
  status_detail: string | null;
  tools: string[];
  created_at: number;
}

export interface Routine {
  id: string;
  bot_id: string;
  name: string;
  cron: string;
  prompt: string;
  enabled: number;
  last_run_at: number | null;
  failure_count: number;
  created_at: number;
}

export interface Job {
  id: string;
  bot_id: string;
  conversation_id: string;
  prompt: string;
  source: string;
  status: "pending" | "running" | "done" | "cancelled" | "error";
  result: string | null;
  created_at: number;
  finished_at: number | null;
}

export interface Skill {
  name: string;
  description: string;
}

export interface CredentialStatus {
  key: string;
  present: boolean;
}

export interface Message {
  id: string;
  conversation_id: string;
  bot_id: string | null;
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  tool_name: string | null;
  tool_args: string | null;
  tool_result: string | null;
  meta: string | null;
  created_at: number;
}

export interface AuditRow {
  id: number;
  bot_id: string | null;
  conversation_id: string | null;
  tool: string;
  args: string | null;
  decision: "allow" | "deny" | "error";
  detail: string | null;
  created_at: number;
}

export interface Memory {
  id: string;
  bot_id: string;
  content: string;
  created_at: number;
}

export interface Bootstrap {
  bots: Bot[];
  conversations: Conversation[];
  channelMembers: ChannelMember[];
  computers: Computer[];
  providers: ModelProvider[];
  toolSources: ToolSource[];
  routines: Routine[];
  jobs: Job[];
  skills: Skill[];
  credentials: CredentialStatus[];
  computerProviderKinds: string[];
}

export interface Approval {
  id: string;
  bot_id: string | null;
  conversation_id: string | null;
  tool: string;
  args: string | null;
  status: "pending" | "approved" | "denied" | "expired";
  decided_at: number | null;
  detail: string | null;
  created_at: number;
}

export interface ChatAttachment {
  path: string;
  name?: string;
  contentType?: string;
}

export interface TaskActivity {
  at: number;
  by: string;
  text: string;
}

export interface Task {
  id: string;
  title: string;
  detail: string;
  status: "backlog" | "doing" | "review" | "done";
  assignee_bot_id: string | null;
  assignee: { emoji: string; name: string } | null;
  conversation_id: string | null;
  due_at: number | null;
  activity: TaskActivity[];
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

export interface BotTemplateRoutine { name: string; cron: string; prompt: string }
export interface Prompt { id: string; title: string; content: string; created_at: number }
export interface FeedbackStats { up: number; down: number; satisfaction: number | null }
export interface ToolUsageRow { tool_name: string; count: number }
export interface ModelUsageRow { model: string; tokens_in: number; tokens_out: number }

export interface BotTemplate {
  id: string; icon: string; title: string; description: string; emoji: string;
  persona: string; firstMessage: string; routines: BotTemplateRoutine[];
  policyPreset: string;
}

export interface UsageCap {
  bot_id: string;
  bot_name: string | null;
  daily_token_cap: number | null;
  monthly_token_cap: number | null;
  enabled: number;
}

export interface NotificationRow {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  created_at: number;
  read_at: number | null;
}

export interface BotStat {
  id: string;
  name: string;
  emoji: string;
  status: string;
  messages: number;
  toolCalls: number;
  jobs24h: number;
  jobsError24h: number;
  routines: number;
  routineFailures: number;
}

export interface Stats {
  bots: BotStat[];
  totals: {
    messages: number;
    toolCalls: number;
    tokensIn: number;
    tokensOut: number;
    jobs24h: number;
    pendingApprovals: number;
    tasks: Record<string, number>;
  };
  feedback?: { up: number; down: number; satisfaction: number | null };
  toolUsage?: { tool_name: string; count: number }[];
  modelUsage?: { model: string; tokens_in: number; tokens_out: number }[];
}


export interface FileEntry { name: string; type: "dir" | "file"; size: number; }
export interface Checkpoint { id: string; workspace: string; label: string; reason: string | null; bytes: number; created_at: number; }
export interface SearchResultsExtra { memoryFiles?: { path: string; snippet: string }[] }

export interface SearchResults {
  messages: { id: string; conversationId: string; role: string; snippet: string; created_at: number; title: string | null; botId: string | null }[];
  bots: { id: string; name: string; emoji: string; persona: string }[];
  memories: { id: string; content: string; created_at: number; botName: string | null }[];
  tasks: { id: string; title: string; status: string; updated_at: number }[];
  memoryFiles?: { path: string; snippet: string }[];
}

export interface PolicyPreset {
  id: string;
  name: string;
  description: string;
  changes: Record<string, string>;
}

export type ServerEvent =
  | { type: "hello"; version: string }
  | { type: "pong" }
  | { type: "chat.accepted"; jobId: string; conversationId: string }
  | { type: "chat.steered"; steered: string; conversationId: string }
  | { type: "chat.message"; conversationId: string; botId: string | null; role: "user" | "assistant"; content: string }
  | { type: "delta"; botId: string; conversationId: string | null; text: string; jobId?: string }
  | { type: "thinking"; botId: string; conversationId: string | null; chars: number; jobId?: string }
  | { type: "tool_start"; botId: string; conversationId: string | null; tool: string; args: Record<string, unknown>; jobId?: string }
  | { type: "tool_end"; botId: string; conversationId: string | null; tool: string; result: unknown; jobId?: string }
  | { type: "chat.error"; jobId?: string; conversationId?: string; error: string }
  | { type: "queue.update"; job: Job }
  | { type: "approval.requested"; approval: Approval }
  | { type: "approval.decided"; id: string; status: "approved" | "denied" | "expired" }
  | { type: "task.updated"; task: Task | null; deleted?: string }
  | { type: "notification.new"; notification: NotificationRow }
  | { type: "error"; error: string };
