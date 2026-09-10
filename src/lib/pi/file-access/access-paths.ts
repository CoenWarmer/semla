/**
 * Placing a tool's path inside the workspace.
 *
 * A tool's `path` is absolute or relative to the agent's cwd, and the agent's
 * cwd is not the workspace root — the session sampled while this was written
 * has `cwd: /Users/coen/Dev` in its header while its commands `cd` into
 * `/Users/coen/Dev/semla`. Three different bases are in play, so resolution
 * happens once, here, and nothing downstream does path arithmetic.
 *
 * The existence check is the other half of making an imperfect shell parser
 * safe. 86% of parsed paths resolve to a real file; the rest are dominated not
 * by parser noise but by files that existed when the session ran and have since
 * moved or been deleted. Marking those `missing` keeps them in the timeline —
 * "the agent read a file that is now gone" is worth knowing — while stopping
 * the scrubber from opening a 404.
 */

import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { splitWorkspacePath } from "@/lib/workspace-path";

import type {
  AccessAgent,
  FileAccess,
  RawAccess,
} from "./access-types";

export interface AccessWorkspace {
  /** Where the agent ran; what a relative tool path is relative to. */
  agentCwd: string;
  workspaceRoot: string;
  /** Workspace-relative project paths this session is linked to. */
  projects: readonly string[];
}

export interface ResolvedAccessPath {
  project: string | null;
  /** Project-relative when `project` is set; otherwise the best available. */
  path: string;
  /** Absolute, for the existence check. */
  absolute: string;
}

/**
 * Where a tool's path lands.
 *
 * `project: null` is an ordinary outcome with two distinct causes, and the
 * `path` it returns differs between them so the UI can say which: a path inside
 * the workspace but outside every linked project keeps its workspace-relative
 * form, and one outside the workspace altogether keeps its absolute form.
 */
export function resolveAccessPath(
  rawPath: string,
  workspace: AccessWorkspace,
): ResolvedAccessPath {
  // resolve() ignores the base for an already-absolute path, so this handles
  // both shapes without asking which one it was given.
  const absolute = resolve(workspace.agentCwd, rawPath);
  const rel = relative(workspace.workspaceRoot, absolute);

  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return { absolute, path: absolute, project: null };
  }

  const split = splitWorkspacePath(workspace.projects, rel);
  return split
    ? { absolute, path: split.path, project: split.project }
    : { absolute, path: rel, project: null };
}

export interface AccessOrigin {
  /** Tool call id; suffixed by the caller when a call yields several. */
  id: string;
  agent: AccessAgent;
  turnId: string;
  at: string;
}

/**
 * A resolved, placed access.
 *
 * `exists` is injectable so tests can describe a workspace without creating
 * one, and so the timeline can memoise it — a turn that reads the same file
 * twenty times should stat it once.
 */
export function toFileAccess(
  raw: RawAccess,
  origin: AccessOrigin,
  workspace: AccessWorkspace,
  exists: (absolutePath: string) => boolean = existsSync,
): FileAccess {
  const resolved = resolveAccessPath(raw.rawPath, workspace);

  return {
    agent: origin.agent,
    at: origin.at,
    confidence: raw.confidence,
    id: origin.id,
    kind: raw.kind,
    missing: !exists(resolved.absolute),
    path: resolved.path,
    project: resolved.project,
    ranges: raw.ranges,
    ...(raw.symbol ? { symbol: raw.symbol } : {}),
    tool: raw.tool,
    turnId: origin.turnId,
  };
}

/** A memoised `existsSync`, for one timeline build. */
export function existenceCache(): (absolutePath: string) => boolean {
  const cache = new Map<string, boolean>();
  return (absolutePath: string) => {
    const cached = cache.get(absolutePath);
    if (cached !== undefined) return cached;

    const result = existsSync(absolutePath);
    cache.set(absolutePath, result);
    return result;
  };
}
