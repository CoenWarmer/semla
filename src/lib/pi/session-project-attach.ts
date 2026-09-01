/**
 * Attaching a project because the agent wrote to it.
 *
 * The rule is narrow on purpose: a session links to a project when a file in it
 * is *changed*, not when one is read. Reads would attach a project every time
 * the agent greps the workspace, and the file browser would attach one every
 * time somebody opens a file to look at it — the list would stop meaning
 * anything.
 *
 * Only `edit` and `write` are observed, and only when they succeed. Writes made
 * through `bash` — `git commit`, `sed -i`, `mv`, generated build output — carry
 * no typed path and are **not** detected. That is a known gap, reported here
 * rather than papered over with a shell parser that would be wrong in ways
 * nobody could predict. A missing link is recoverable: the project can be
 * attached by hand.
 */

import { projectOfWrittenPath } from "@/lib/pi/project-of-path";
import type { ProjectLink } from "@/lib/pi/session-meta";
import { attachProject } from "@/lib/pi/session-project-links";
import { updateSessionProjects } from "@/lib/pi/session-project-store";

/**
 * The file a tool call is about to change, or null if it changes no file.
 *
 * `edit` and `write` both take a single `path`, relative or absolute — see the
 * typebox schemas in the pi package's `core/tools/{edit,write}`. Anything else,
 * including every read-only tool, yields null.
 */
export function writtenPath(toolName: string, args: unknown): string | null {
  if (toolName !== "edit" && toolName !== "write") return null;

  const path = (args as { path?: unknown } | null | undefined)?.path;
  return typeof path === "string" && path.trim() !== "" ? path.trim() : null;
}

/**
 * Record that a session touched `projectPath`, on disk and in the mirror.
 *
 * Returns true when the link set actually changed, so a caller can skip the
 * mirror round trip for the overwhelmingly common case: the twentieth edit of
 * a turn to a project that was attached at the first.
 *
 * `mirror` is injectable so tests do not reach for a database, and `dir` so
 * they do not write to the real session directory.
 */
export async function recordProjectTouch(
  sessionId: string,
  projectPath: string,
  options: {
    at?: string;
    dir?: string;
    mirror?: (id: string, links: readonly ProjectLink[]) => Promise<void>;
  } = {},
): Promise<boolean> {
  const { at = new Date().toISOString(), ...rest } = options;

  const result = await updateSessionProjects(
    sessionId,
    (links) => attachProject(links, { at, origin: "observed", path: projectPath }),
    rest,
  );

  return result.status === "ok" && result.changed;
}

/**
 * Resolve a written path to its project and attach it, once per turn.
 *
 * `attachedThisTurn` is what keeps this cheap: a turn that edits twenty files
 * in one repository does one read-modify-write, not twenty. The check and the
 * insertion into that set are adjacent and synchronous, so two tool calls
 * finishing on the same new project cannot both get past it.
 *
 * Once per turn is also the right granularity for `lastTouchedAt`: it is a
 * record of which turn touched the project, not of which keystroke did.
 */
export async function attachWrittenProject(
  sessionId: string,
  path: string,
  attachedThisTurn: Set<string>,
): Promise<void> {
  const project = await projectOfWrittenPath(path);
  if (!project || attachedThisTurn.has(project)) return;

  attachedThisTurn.add(project);
  await recordProjectTouch(sessionId, project);
}
