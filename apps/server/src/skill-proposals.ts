import fs from "node:fs";
import path from "node:path";
import { db, uid, now } from "./db.js";
import { SKILLS_DIR } from "./config.js";
import { providerForRow, textContent } from "./agent/providers.js";
import { getProviderForBot } from "./agent/loop.js";
import { broadcast } from "./events.js";

/**
 * 대화→스킬 자동 제안 (CopilotKit Intelligence "Automatic learning"의 자체호스팅 버전):
 * 완료된 대화를 기본 로컬 모델로 증류해 SKILL.md 제안을 만들고, 사람이 검토·승인하면
 * 기존 skills 라이브러리(data/skills/<name>/SKILL.md)에 반영한다. 클라우드·키 불필요.
 *
 * 승인 전까지 봇은 제안을 보지 못한다 — Intelligence의 "review before publish" 원칙과 같다.
 */

db.exec(`CREATE TABLE IF NOT EXISTS skill_proposals (
  id TEXT PRIMARY KEY,
  bot_id TEXT,
  conversation_id TEXT,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  status TEXT NOT NULL,            -- pending | approved | rejected
  reason TEXT,
  created_at INTEGER NOT NULL
)`);

export interface SkillProposalRow {
  id: string;
  bot_id: string | null;
  conversation_id: string | null;
  name: string;
  description: string;
  content: string;
  status: string;
  reason: string | null;
  created_at: number;
}

const MAX_MESSAGES = 40;
const MAX_CHARS_PER_MSG = 600;

/** 대화에서 반복 가능한 절차를 뽑아 스킬 제안을 만든다. 모델 호출 실패 시 null. */
export async function proposeSkillFromConversation(conversationId: string): Promise<{ ok: boolean; error?: string; proposal?: SkillProposalRow }> {
  const conv = db.prepare("SELECT * FROM conversations WHERE id=?").get(conversationId) as { id: string; kind: string; bot_id: string | null } | undefined;
  if (!conv) return { ok: false, error: "conversation not found" };
  const rows = db.prepare(
    "SELECT role, content FROM messages WHERE conversation_id=? AND role IN ('user','assistant') AND content != '' ORDER BY created_at DESC LIMIT ?"
  ).all(conversationId, MAX_MESSAGES).reverse() as { role: string; content: string }[];
  if (rows.length < 4) return { ok: false, error: "대화가 너무 짧습니다 (4개 메시지 이상 필요)" };

  const bot = conv.bot_id ? db.prepare("SELECT * FROM bots WHERE id=?").get(conv.bot_id) as { id: string; name: string } | undefined : undefined;
  if (!bot) return { ok: false, error: "DM 대화에서만 스킬을 제안할 수 있습니다" };
  const provider = providerForRow(getProviderForBot(bot as never));
  const transcript = rows.map((r) => `${r.role === "user" ? "사용자" : "봇"}: ${r.content.slice(0, MAX_CHARS_PER_MSG)}`).join("\n");

  const res = await provider.chat({
    messages: [
      {
        role: "system",
        content: [
          "아래 대화에서 사용자가 반복적으로 하고 싶어하는 작업 절차를 하나의 '스킬'로 증류한다.",
          "스킬은 나중에 비슷한 요청이 왔을 때 봇이 따라할 수 있는 단계별 지침이다.",
          "출력 형식을 정확히 지킨다 (다른 설명 금지):",
          "NAME: <kebab-case-슬러그 (영문 소문자·숫자·하이픈)>",
          "DESCRIPTION: <한국어 한 문장 — 이 스킬이 언제 쓰이는지>",
          "STEPS:",
          "1. <단계>",
          "2. <단계> (3~7단계, 도구 이름이 언급되면 포함)",
          "대화가 일회성 질문이거나 절차가 없다면 exactly: NO_SKILL 만 출력한다.",
        ].join("\n"),
      },
      { role: "user", content: transcript },
    ],
    tools: [],
  });
  const raw = textContent(res.message.content).trim();
  if (!raw || raw.includes("NO_SKILL")) return { ok: false, error: "이 대화에서 뽑을 만한 반복 절차를 찾지 못했습니다" };

  const name = (raw.match(/^NAME:\s*(\S+)/m)?.[1] ?? "").replace(/[^a-zA-Z0-9-]/g, "").slice(0, 40);
  const description = (raw.match(/^DESCRIPTION:\s*(.+)$/m)?.[1] ?? "").trim().slice(0, 200);
  if (!name || !description) return { ok: false, error: "모델 출력 형식이 올바르지 않습니다" };
  const stepsBlock = raw.split(/^STEPS:\s*$/m)[1]?.trim() ?? "";
  if (!stepsBlock) return { ok: false, error: "모델 출력에 단계가 없습니다" };

  const content = [`---`, `name: ${name}`, `description: ${description}`, `---`, ``, `# ${name}`, ``, stepsBlock, ``].join("\n");
  const id = uid();
  db.prepare(
    "INSERT INTO skill_proposals (id, bot_id, conversation_id, name, description, content, status, created_at) VALUES (?,?,?,?,?,?,'pending',?)"
  ).run(id, conv.bot_id, conversationId, name, description, content, now());
  const proposal = getProposal(id);
  broadcast({ type: "skill.proposed", proposal });
  return { ok: true, proposal };
}

function getProposal(id: string): SkillProposalRow | undefined {
  return db.prepare("SELECT * FROM skill_proposals WHERE id=?").get(id) as unknown as SkillProposalRow | undefined;
}

export function listProposals(status?: string): SkillProposalRow[] {
  const q = status
    ? "SELECT * FROM skill_proposals WHERE status=? ORDER BY created_at DESC LIMIT 100"
    : "SELECT * FROM skill_proposals ORDER BY created_at DESC LIMIT 100";
  return db.prepare(q).all(...(status ? [status] : [])) as unknown as SkillProposalRow[];
}

/** 승인 → 기존 skills 라이브러리에 파일로 반영 (봇의 skills.list가 즉시 인식). */
export function approveProposal(id: string): { ok: boolean; error?: string } {
  const p = getProposal(id);
  if (!p) return { ok: false, error: "proposal not found" };
  if (p.status !== "pending") return { ok: false, error: `already ${p.status}` };
  const dir = path.join(SKILLS_DIR, p.name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), p.content, "utf8");
  db.prepare("UPDATE skill_proposals SET status='approved', reason='published to skills library' WHERE id=?").run(id);
  broadcast({ type: "skill.approved", id, name: p.name });
  return { ok: true };
}

export function rejectProposal(id: string, reason?: string): { ok: boolean; error?: string } {
  const p = getProposal(id);
  if (!p) return { ok: false, error: "proposal not found" };
  if (p.status !== "pending") return { ok: false, error: `already ${p.status}` };
  db.prepare("UPDATE skill_proposals SET status='rejected', reason=? WHERE id=?").run(reason?.slice(0, 300) ?? "rejected", id);
  broadcast({ type: "skill.rejected", id });
  return { ok: true };
}
