import { readdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { execSync } from "node:child_process";

import { PI_WORKSPACE_ROOT } from "./runtime-config";

export type WorkspaceProject = {
  name: string;
  path: string;
  branch: string | null;
  lastCommitAt: number | null;
  stalenessText: string;
};

function formatStaleness(lastCommitAt: number | null, now: number): string {
  if (lastCommitAt === null) return "no commits";
  const diffMs = now - lastCommitAt * 1000;
  const diffMinutes = Math.floor(diffMs / 60_000);
  if (diffMinutes < 2) return "just now";
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  const diffWeeks = Math.floor(diffDays / 7);
  if (diffWeeks < 5) return `${diffWeeks}w ago`;
  const diffMonths = Math.floor(diffDays / 30);
  if (diffMonths < 12) return `${diffMonths}mo ago`;
  return `${Math.floor(diffDays / 365)}y ago`;
}

export function getWorkspaceProjects(): WorkspaceProject[] {
  const now = Date.now();
  try {
    const entries = readdirSync(PI_WORKSPACE_ROOT, { withFileTypes: true });
    return entries
      .filter(
        (e) =>
          e.isDirectory() &&
          existsSync(join(PI_WORKSPACE_ROOT, e.name, ".git")),
      )
      .map((e): WorkspaceProject => {
        const path = join(PI_WORKSPACE_ROOT, e.name);
        let branch: string | null = null;
        let lastCommitAt: number | null = null;
        try {
          branch =
            execSync("git branch --show-current", {
              cwd: path,
              encoding: "utf8",
              stdio: "pipe",
              timeout: 2000,
            }).trim() || null;
          const ts = execSync("git log -1 --format=%ct", {
            cwd: path,
            encoding: "utf8",
            stdio: "pipe",
            timeout: 2000,
          }).trim();
          lastCommitAt = ts ? parseInt(ts, 10) : null;
        } catch {
          // not a valid git repo or no commits yet
        }
        return {
          name: basename(path),
          path,
          branch,
          lastCommitAt,
          stalenessText: formatStaleness(lastCommitAt, now),
        };
      });
  } catch {
    return [];
  }
}
