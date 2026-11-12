import { DatabaseSync } from "node:sqlite";
import { DB_PATH, ensureDirs } from "./config.js";

ensureDirs();

export const db = new DatabaseSync(DB_PATH);

db.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS bots (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  emoji TEXT NOT NULL DEFAULT '🤖',
  persona TEXT NOT NULL DEFAULT '',
  provider_id TEXT,
  computer_id TEXT,
  tts_provider TEXT NOT NULL DEFAULT 'browser',
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,              -- 'dm' | 'channel'
  title TEXT,
  bot_id TEXT,                     -- dm only
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS channel_members (
  conversation_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  PRIMARY KEY (conversation_id, bot_id)
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  bot_id TEXT,
  role TEXT NOT NULL,              -- user | assistant | system
  content TEXT NOT NULL DEFAULT '',
  tool_name TEXT,
  tool_args TEXT,
  tool_result TEXT,
  meta TEXT,                       -- json: attachments, model, usage, source
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at);
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS routines (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  name TEXT NOT NULL,
  cron TEXT NOT NULL,
  prompt TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at INTEGER,
  failure_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS computers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,              -- 'team' | 'private'
  provider TEXT NOT NULL,          -- local | docker | e2b | daytona | createos | boat
  config TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS model_providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,              -- openai-compatible | anthropic | mock
  base_url TEXT,
  api_key_enc TEXT,
  model TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tool_sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,              -- mcp | openapi | composio | pipedream | treg
  config TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'unverified',
  status_detail TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS credentials (
  key TEXT PRIMARY KEY,
  value_enc TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id TEXT,
  conversation_id TEXT,
  tool TEXT NOT NULL,
  args TEXT,
  decision TEXT NOT NULL,          -- allow | deny | error
  detail TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS queue_jobs (
  id TEXT PRIMARY KEY,
  bot_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  prompt TEXT NOT NULL,
  source TEXT NOT NULL,            -- user | routine | delegation | channel | task
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | running | done | cancelled | error
  result TEXT,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'backlog',  -- backlog | doing | review | done
  assignee_bot_id TEXT,
  conversation_id TEXT,
  due_at INTEGER,
  activity TEXT NOT NULL DEFAULT '[]',     -- [{at, by, text}]
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, updated_at);
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                      -- approval | task | routine | system
  title TEXT NOT NULL,
  body TEXT,
  created_at INTEGER NOT NULL,
  read_at INTEGER
);
CREATE TABLE IF NOT EXISTS checkpoints (
  id TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,
  label TEXT NOT NULL,
  file TEXT NOT NULL,
  reason TEXT,
  bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tool_policies (
  tool TEXT PRIMARY KEY,
  mode TEXT NOT NULL               -- allow | ask (row missing = ask)
);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  bot_id TEXT,
  conversation_id TEXT,
  tool TEXT NOT NULL,
  args TEXT,
  status TEXT NOT NULL,            -- pending | approved | denied | expired
  decided_at INTEGER,
  detail TEXT,
  created_at INTEGER NOT NULL
);
`);

// approval policy seed: read-only tools flow, side-effecting tools ask first
{
  const seed: [string, "allow" | "ask"][] = [
    ["terminal.exec", "ask"],
    ["fs.write", "ask"],
    ["fs.read", "allow"],
    ["fs.list", "allow"],
    ["browser.fetch", "allow"],
    ["browser.snapshot", "allow"],
    ["browser.close", "allow"],
    ["browser.open", "ask"],
    ["browser.click", "ask"],
    ["browser.type", "ask"],
    ["desktop.screenshot", "allow"],
    ["desktop.list_apps", "allow"],
    ["desktop.snapshot", "allow"],
    ["desktop.act", "ask"],
    ["memory.save", "allow"],
    ["memory.read", "allow"],
    ["memory.write", "allow"],
    ["memory.search", "allow"],
    ["skills.list", "allow"],
    ["skills.read", "allow"],
    ["bot.delegate", "allow"],
    ["subagent.run", "allow"],
    ["search.web", "allow"],
    ["task.update", "allow"],
    ["email.send", "ask"],
    ["email.status", "allow"],
    ["knowledge.index", "allow"],
    ["knowledge.search", "allow"],
    ["knowledge.list", "allow"],
    ["arxiv.search", "allow"],
    ["pubmed.search", "allow"],
    ["research.report", "ask"],
    ["ui.render", "allow"],
    ["phone.sms", "ask"],
    ["phone.call", "ask"],
    ["phone.status", "allow"],
    ["payment.send", "ask"],
    ["payment.status", "allow"],
  ];
  const ins = db.prepare("INSERT OR IGNORE INTO tool_policies (tool, mode) VALUES (?,?)");
  for (const [tool, mode] of seed) ins.run(tool, mode);
}


// ---- additive migrations (2026-11-04): steering mute + memory channel scope ----
try { db.exec("ALTER TABLE conversations ADD COLUMN muted INTEGER NOT NULL DEFAULT 0"); } catch { /* exists */ }
try { db.exec("ALTER TABLE memories ADD COLUMN scope TEXT NOT NULL DEFAULT 'dm'"); } catch { /* exists */ }


try { db.exec("ALTER TABLE conversations ADD COLUMN instructions TEXT"); } catch { }
try { db.exec("ALTER TABLE conversations ADD COLUMN responder_mode TEXT NOT NULL DEFAULT 'all'"); } catch { }
try { db.exec("ALTER TABLE channel_members ADD COLUMN role TEXT NOT NULL DEFAULT 'member'"); } catch { }
try { db.exec("ALTER TABLE routines ADD COLUMN enabled2 INTEGER"); } catch { }
CREATE_TABLE_IF_NOT_EXISTS_usage_caps: {
  db.exec(`CREATE TABLE IF NOT EXISTS usage_caps (
    bot_id TEXT PRIMARY KEY,
    daily_token_cap INTEGER,
    monthly_token_cap INTEGER,
    enabled INTEGER NOT NULL DEFAULT 0
  )`);
}

export const uid = (): string => crypto.randomUUID();
export const now = (): number => Date.now();

// row mappers: sqlite returns integers for INTEGER columns; keep raw rows and map at call sites.
export interface BotRow {
  id: string; name: string; emoji: string; persona: string; provider_id: string | null;
  computer_id: string | null; tts_provider: string; status: string; created_at: number;
}
export interface ConversationRow {
  id: string; kind: string; title: string | null; bot_id: string | null; created_at: number;
}
export interface MessageRow {
  id: string; conversation_id: string; bot_id: string | null; role: string; content: string;
  tool_name: string | null; tool_args: string | null; tool_result: string | null;
  meta: string | null; created_at: number;
}
export interface ComputerRow {
  id: string; name: string; kind: string; provider: string; config: string; created_at: number;
}
export interface ProviderRow {
  id: string; name: string; kind: string; base_url: string | null; api_key_enc: string | null;
  model: string; is_default: number; created_at: number;
}
export interface ToolSourceRow {
  id: string; name: string; kind: string; config: string; enabled: number;
  status: string; status_detail: string | null; created_at: number;
}
export interface RoutineRow {
  id: string; bot_id: string; name: string; cron: string; prompt: string;
  enabled: number; last_run_at: number | null; failure_count: number; created_at: number;
}
export interface JobRow {
  id: string; bot_id: string; conversation_id: string; prompt: string; source: string;
  status: string; result: string | null; created_at: number; finished_at: number | null;
}
