import fs from "node:fs";
import path from "node:path";
import { MEMORY_DIR } from "./config.js";

export interface MemoryFile { path: string; content: string; }

/** Flat list of Markdown memory files under data/memory (bounded). */
export function readdirRecursive(dir: string = MEMORY_DIR, prefix = ""): MemoryFile[] {
  const out: MemoryFile[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    if (e.isDirectory()) {
      out.push(...readdirRecursive(path.join(dir, e.name), `${prefix}${e.name}/`));
    } else if (/\.(md|txt)$/i.test(e.name)) {
      try {
        out.push({ path: `${prefix}${e.name}`, content: fs.readFileSync(path.join(dir, e.name), "utf8").slice(0, 100_000) });
      } catch { /* unreadable */ }
    }
  }
  return out;
}
