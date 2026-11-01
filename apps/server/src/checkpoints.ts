import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { db, uid, now } from "./db.js";
import { DATA_DIR } from "./config.js";

export const CHECKPOINTS_DIR = path.join(DATA_DIR, "checkpoints");
const KEEP_PER_WORKSPACE = 10;

export interface CheckpointRow {
  id: string;
  workspace: string;
  label: string;
  file: string;
  reason: string;
  bytes: number;
  created_at: number;
}

/**
 * Workspace snapshots (tar.gz), taken automatically before approved side-effect
 * tools run. Restore replaces the workspace contents with the snapshot — the
 * approval queue's undo button. (QwenPaw checkpoint pattern.)
 */
export function snapshotSync(workspaceDir: string, label: string, reason: string): CheckpointRow | null {
  try {
    fs.mkdirSync(CHECKPOINTS_DIR, { recursive: true });
    const id = uid();
    const file = path.join(CHECKPOINTS_DIR, `cp-${now()}-${id.slice(0, 6)}.tar.gz`);
    execFileSync("tar", ["-czf", file, "-C", workspaceDir, "."], { timeout: 120_000, stdio: "ignore" });
    const bytes = fs.statSync(file).size;
    db.prepare("INSERT INTO checkpoints (id, workspace, label, file, reason, bytes, created_at) VALUES (?,?,?,?,?,?,?)")
      .run(id, workspaceDir, label, file, reason, bytes, now());
    prune(workspaceDir);
    return { id, workspace: workspaceDir, label, file, reason, bytes, created_at: now() };
  } catch {
    return null; // best-effort: a failed snapshot must never block the tool
  }
}

export function listCheckpoints(workspace?: string): CheckpointRow[] {
  return (workspace
    ? db.prepare("SELECT * FROM checkpoints WHERE workspace=? ORDER BY created_at DESC LIMIT 50").all(workspace)
    : db.prepare("SELECT * FROM checkpoints ORDER BY created_at DESC LIMIT 50").all()) as unknown as CheckpointRow[];
}

/** Replace the workspace contents with the snapshot (destructive to later changes). */
export function restoreCheckpoint(id: string): { ok: boolean; error?: string } {
  const row = db.prepare("SELECT * FROM checkpoints WHERE id=?").get(id) as CheckpointRow | undefined;
  if (!row) return { ok: false, error: "checkpoint not found" };
  if (!fs.existsSync(row.file)) return { ok: false, error: "snapshot file missing" };
  try {
    fs.mkdirSync(row.workspace, { recursive: true });
    for (const entry of fs.readdirSync(row.workspace)) {
      fs.rmSync(path.join(row.workspace, entry), { recursive: true, force: true });
    }
    execFileSync("tar", ["-xzf", row.file, "-C", row.workspace], { timeout: 120_000, stdio: "ignore" });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function deleteCheckpoint(id: string): void {
  const row = db.prepare("SELECT * FROM checkpoints WHERE id=?").get(id) as CheckpointRow | undefined;
  if (!row) return;
  try { fs.unlinkSync(row.file); } catch { /* already gone */ }
  db.prepare("DELETE FROM checkpoints WHERE id=?").run(id);
}

function prune(workspaceDir: string): void {
  const rows = db.prepare("SELECT id FROM checkpoints WHERE workspace=? ORDER BY created_at DESC").all(workspaceDir) as { id: string }[];
  for (const old of rows.slice(KEEP_PER_WORKSPACE)) deleteCheckpoint(old.id);
}
