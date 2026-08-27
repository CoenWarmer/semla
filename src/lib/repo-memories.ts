import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

import { SEMLA_MEMORIES_DIR } from "@/lib/pi/runtime-config";

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
