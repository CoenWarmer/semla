import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

import { SEMLA_MEMORIES_DIR } from "@/lib/pi/runtime-config";

/**
 * Maximum characters injected into the system prompt per repo memory.
 * ~8 000 chars ≈ 2 000 tokens — enough for a full summary plus most sections
 * of a typical codebase memory without bloating every API call for large repos.
 * The orient skill puts a compact Summary section first so the highest-signal
 * content always fits within this window.
 */
export const MEMORY_INJECT_LIMIT = 8_000;

/** Converts an absolute repo path into a safe filename slug. */
export function repoMemorySlug(repoPath: string): string {
  return repoPath.replace(/^\//, "").replace(/[^a-zA-Z0-9]/g, "_");
}

export function repoMemoryPath(repoPath: string): string {
  return join(SEMLA_MEMORIES_DIR, `${repoMemorySlug(repoPath)}.md`);
}

export async function getRepoMemory(repoPath: string): Promise<string | null> {
  try {
    return await readFile(repoMemoryPath(repoPath), "utf8");
  } catch {
    return null;
  }
}

export async function hasRepoMemory(repoPath: string): Promise<boolean> {
  try {
    await access(repoMemoryPath(repoPath));
    return true;
  } catch {
    return false;
  }
}
