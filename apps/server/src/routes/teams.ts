import { Hono } from "hono";
import { z } from "zod";
import { db, uid, now } from "../db.js";
import { getOrCreateDmConversation } from "../agent/loop.js";

/**
 * Team sharing (OpenMausBot pattern): export the whole team — bots with
 * personas, channels with members and instructions, routines — as one portable
 * Markdown file with YAML frontmatter. Import shows a preview before creating
 * anything. Secrets never leave; bots arrive on the safe (ask) preset.
 */

export const teamsRouter = new Hono();

interface ExportBot { name: string; emoji: string; persona: string; ttsProvider: string }
interface ExportChannel { title: string; instructions: string; members: string[]; responderMode: string }
interface ExportRoutine { botName: string; name: string; cron: string; prompt: string }

function scrubSecrets(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]{20,}/g, "[REDACTED]")
    .replace(/xai-[A-Za-z0-9_-]{20,}/g, "[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9_.-]{20,}/g, "Bearer [REDACTED]")
    .replace(/(api[_-]?key|token|password|secret)\s*[=:]\s*\S{8,}/gi, "$1=[REDACTED]");
}

function yamlEscape(s: string): string {
  if (/[:#\n\r]/.test(s)) return JSON.stringify(s);
  return s;
}

teamsRouter.get("/teams/export", (c) => {
  const bots = db.prepare("SELECT * FROM bots ORDER BY created_at").all() as unknown as { id: string; name: string; emoji: string; persona: string; tts_provider: string; status: string }[];
  const channels = db.prepare("SELECT * FROM conversations WHERE kind='channel' ORDER BY created_at").all() as unknown as { id: string; title: string; instructions: string | null }[];
  const members = db.prepare("SELECT * FROM channel_members").all() as unknown as { conversation_id: string; bot_id: string }[];
  const routines = db.prepare("SELECT * FROM routines ORDER BY created_at").all() as unknown as { bot_id: string; name: string; cron: string; prompt: string }[];
  const botName = new Map(bots.map((b) => [b.id, b.name]));

  const expBots: ExportBot[] = bots.filter((b) => b.status !== "deleted").map((b) => ({
    name: b.name, emoji: b.emoji, persona: scrubSecrets(b.persona), ttsProvider: b.tts_provider,
  }));
  const expChannels: ExportChannel[] = channels.map((ch) => ({
    title: ch.title ?? "channel",
    instructions: scrubSecrets(ch.instructions ?? ""),
    members: members.filter((m) => m.conversation_id === ch.id).map((m) => botName.get(m.bot_id) ?? "?"),
    responderMode: "all",
  }));
  const expRoutines: ExportRoutine[] = routines.map((r) => ({
    botName: botName.get(r.bot_id) ?? "?", name: r.name, cron: r.cron, prompt: scrubSecrets(r.prompt),
  }));

  const lines: string[] = [];
  lines.push("---");
  lines.push(`name: ${yamlEscape("OpenBot Team")}`);
  lines.push(`exported: ${new Date().toISOString()}`);
  lines.push(`bots: ${expBots.length}`);
  lines.push(`channels: ${expChannels.length}`);
  lines.push(`routines: ${expRoutines.length}`);
  lines.push("---");
  lines.push("");
  lines.push("# OpenBot Team");
  lines.push("");
  for (const b of expBots) {
    lines.push(`## 🤖 ${b.emoji} ${b.name}`);
    lines.push(`- TTS: ${b.ttsProvider}`);
    if (b.persona) lines.push(`- Persona: ${yamlEscape(b.persona)}`);
    lines.push("");
  }
  for (const ch of expChannels) {
    lines.push(`## #️⃣ ${ch.title}`);
    if (ch.instructions) lines.push(`- Instructions: ${yamlEscape(ch.instructions)}`);
    lines.push(`- Members: ${ch.members.join(", ")}`);
    lines.push(`- Responder: ${ch.responderMode}`);
    lines.push("");
  }
  for (const r of expRoutines) {
    lines.push(`## ⏰ ${r.name} (${r.botName})`);
    lines.push(`- Cron: \`${r.cron}\``);
    lines.push(`- Prompt: ${yamlEscape(r.prompt)}`);
    lines.push("");
  }
  lines.push("<!-- Exported by OpenBot. Secrets scrubbed. Bots arrive on the safe (ask) preset. -->");

  return c.text(lines.join("\n"), 200, { "content-type": "text/markdown; charset=utf-8" });
});

const ImportTeam = z.object({
  markdown: z.string().min(10).max(200_000),
  dryRun: z.boolean().optional().default(false),
});

function parseTeamMarkdown(md: string): { bots: ExportBot[]; channels: ExportChannel[]; routines: ExportRoutine[]; name: string } {
  const fm = /---\n([\s\S]*?)\n---/.exec(md);
  const nameMatch = fm ? /name:\s*(.+)/.exec(fm[1]) : null;
  const name = nameMatch ? nameMatch[1].replace(/^["']|["']$/g, "").trim() : "Imported Team";

  const bots: ExportBot[] = [];
  const channels: ExportChannel[] = [];
  const routines: ExportRoutine[] = [];
  const botNames = new Set<string>();

  const sections = md.split(/\n## /).slice(1);
  for (const sec of sections) {
    const title = sec.split("\n")[0].trim();
    const isBot = /^🤖|^\S+\s+\S+$/.test(title) && !title.startsWith("#");
    const isChannel = title.startsWith("#️⃣") || /^#/.test(title);
    const isRoutine = title.includes("⏰") || /\(\d+\s/.test(title);

    if (isRoutine) {
      const botName = /\((.+)\)$/.exec(title)?.[1] ?? "?";
      const cron = /Cron:\s*`(.+?)`/.exec(sec)?.[1] ?? "";
      const prompt = /Prompt:\s*(.+)/.exec(sec)?.[1]?.replace(/^["']|["']$/g, "") ?? "";
      if (cron && prompt) routines.push({ botName, name: title.replace(/\s*\(.+\)$/, ""), cron, prompt: scrubSecrets(prompt) });
    } else if (isChannel) {
      const chTitle = title.replace(/^#️⃣\s*/, "").replace(/^#/, "").trim();
      const instructions = /Instructions:\s*(.+)/.exec(sec)?.[1]?.replace(/^["']|["']$/g, "") ?? "";
      const members = /Members:\s*(.+)/.exec(sec)?.[1]?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
      const responderMode = /Responder:\s*(\w+)/.exec(sec)?.[1] ?? "all";
      channels.push({ title: chTitle, instructions: scrubSecrets(instructions), members, responderMode });
    } else if (isBot || title.includes(" ")) {
      const emojiMatch = title.match(/^\S+/);
      const botName = title.replace(/^\S+\s+/, "").trim() || title;
      const emoji = emojiMatch ? emojiMatch[0] : "🤖";
      const persona = /Persona:\s*(.+)/.exec(sec)?.[1]?.replace(/^["']|["']$/g, "") ?? "";
      const tts = /TTS:\s*(\S+)/.exec(sec)?.[1] ?? "browser";
      bots.push({ name: botName, emoji, persona: scrubSecrets(persona), ttsProvider: tts });
      botNames.add(botName);
    }
  }
  return { bots, channels, routines, name };
}

teamsRouter.post("/teams/import", async (c) => {
  const parsed = ImportTeam.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "markdown required", issues: parsed.error.issues.slice(0, 3) }, 400);
  const { markdown, dryRun } = parsed.data;
  const team = parseTeamMarkdown(markdown);

  if (dryRun) {
    return c.json({ preview: team, note: "Preview — nothing created. Set dryRun=false to import." });
  }

  const nameToId = new Map<string, string>();
  for (const b of team.bots) {
    const id = uid();
    db.prepare("INSERT INTO bots (id, name, emoji, persona, tts_provider, status, created_at) VALUES (?,?,?,?,?,'active',?)").run(
      id, b.name, b.emoji, b.persona, b.ttsProvider, now()
    );
    getOrCreateDmConversation(id);
    nameToId.set(b.name, id);
  }
  for (const ch of team.channels) {
    const id = uid();
    db.prepare("INSERT INTO conversations (id, kind, title, bot_id, instructions, created_at) VALUES (?,?,?,?,?,?)").run(
      id, "channel", ch.title, null, ch.instructions || null, now()
    );
    const ins = db.prepare("INSERT OR IGNORE INTO channel_members (conversation_id, bot_id) VALUES (?,?)");
    for (const m of ch.members) {
      const botId = nameToId.get(m);
      if (botId) ins.run(id, botId);
    }
  }
  for (const r of team.routines) {
    const botId = nameToId.get(r.botName);
    if (!botId) continue;
    try {
      const { parseCron } = await import("../cron.js");
      parseCron(r.cron);
    } catch { continue; }
    db.prepare("INSERT INTO routines (id, bot_id, name, cron, prompt, enabled, failure_count, created_at) VALUES (?,?,?,?,?,0,0,?)").run(
      uid(), botId, r.name, r.cron, r.prompt, now()
    );
  }
  return c.json({ imported: { bots: team.bots.length, channels: team.channels.length, routines: team.routines.length } }, 201);
});
