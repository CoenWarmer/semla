/**
 * Where the agent actually runs.
 *
 * The workspace root is the *parent* of every project — 50 repositories and
 * 131 GB on the machine this was written for — and pointing a session at it
 * made every prompt pay for the whole tree. `@mrclrchtr/supi-code-intelligence`
 * stands up an LSP workspace over the session's cwd from a `session_start`
 * handler, so `bindExtensions` took 70 s on the first prompt of a process and
 * ~32 s on every prompt after it, whatever the prompt said and whichever tools
 * were selected. The same bind against a single project is sub-second.
 *
 * A session already knows which repositories it works in, anchor first, so it
 * can say where it belongs rather than defaulting to everything. Other repos
 * stay reachable: they are addressed by absolute path, which is what a
 * multi-project session's own links already carry.
 *
 * Falling back to the workspace root is deliberate on every failure. A session
 * with no project yet — the first prompt of a brand new one — and a session
 * whose project directory has since been moved must both still start. Slow is
 * recoverable; refusing to run a turn is not.
 */

import { statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { PI_WORKSPACE_ROOT } from "@/lib/pi/runtime-config";

export const resolveSessionCwd = (
  /** Workspace-relative repos this session works in, anchor first. */
  projects: readonly string[],
  workspaceRoot: string = PI_WORKSPACE_ROOT,
): string => {
  const anchor = projects[0]?.trim();
  if (!anchor) return workspaceRoot;

  const candidate = resolve(workspaceRoot, anchor);

  // The anchor comes from the database, so it is treated as untrusted input:
  // an absolute path or one climbing out of the root would silently move the
  // agent — and its bash executor — somewhere the rest of the app cannot
  // address.
  const rel = relative(workspaceRoot, candidate);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return workspaceRoot;
  }

  try {
    if (!statSync(candidate).isDirectory()) return workspaceRoot;
  } catch {
    // Renamed, moved, or never there.
    return workspaceRoot;
  }

  return candidate;
};
