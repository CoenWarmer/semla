/**
 * Detect wiki vaults that would silently take over from Semla's own.
 *
 * pi-llm-wiki resolves a vault by asking, in order: is there one at the current
 * directory, then what does WIKI_HOME say, then walk up. The first question
 * wins — so a `.llm-wiki` sitting in any repo the agent works in shadows
 * `.semla-wiki` from then on, and every page written afterwards lands there
 * instead. That has already happened once: a stray vault appeared in the repo
 * root, took three captures with it, and the agent noticed only because it
 * wrote an insight page about its own confusion.
 *
 * Nothing here deletes anything. A vault is somebody's notes, and the failure
 * this prevents is silence, not the directory's existence.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** A directory shadows Semla's vault if pi-llm-wiki would resolve to it first. */
const holdsVault = (dir: string): boolean =>
  existsSync(join(dir, ".llm-wiki")) || existsSync(join(dir, ".wiki"));

/**
 * Vaults inside the workspace that would win over `wikiHome`.
 *
 * Only the workspace root and the repositories directly under it are checked:
 * those are the directories the agent actually runs in, and a deep scan of
 * every project on the machine would cost more than the problem.
 */
export function findShadowingVaults(
  workspaceRoot: string,
  wikiHome: string,
): string[] {
  const candidates: string[] = [];

  if (holdsVault(workspaceRoot)) candidates.push(workspaceRoot);

  let entries: string[] = [];
  try {
    entries = readdirSync(workspaceRoot);
  } catch {
    return candidates;
  }

  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    const dir = join(workspaceRoot, entry);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    // Semla's own vault lives under wikiHome and is the one being protected.
    if (dir === wikiHome) continue;
    if (holdsVault(dir)) candidates.push(dir);
  }

  return candidates;
}

/** What to tell someone who has one, in terms of what it will do to them. */
export function describeShadowingVaults(paths: string[], wikiHome: string): string {
  return [
    `[wiki] ${paths.length} vault(s) inside the workspace will take precedence over ${wikiHome}:`,
    ...paths.map((path) => `  ${join(path, ".llm-wiki")}`),
    "  pi-llm-wiki prefers a vault in the working directory, so orient will " +
      "write there instead. Move or remove them to keep one wiki.",
  ].join("\n");
}
