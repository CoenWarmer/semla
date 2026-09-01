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
import { readSessionMeta, writeSessionMeta, type ProjectLink } from "@/lib/pi/session-meta";
import { attachProject } from "@/lib/pi/session-project-links";
import { mirrorSessionProjects } from "@/lib/pi/session-project-mirror";

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
  const { at = new Date().toISOString(), dir, mirror = mirrorSessionProjects } = options;

  const meta = dir ? readSessionMeta(sessionId, dir) : readSessionMeta(sessionId);
  if (!meta) return false;

  const next = attachProject(meta.projects, { at, origin: "observed", path: projectPath });
  if (sameLinks(meta.projects, next)) return false;

  // Disk first, and synchronously, so the append cannot interleave with
  // another writer. See writeSessionMeta on why the synchrony is load-bearing.
  if (dir) writeSessionMeta(sessionId, { projects: next }, dir);
  else writeSessionMeta(sessionId, { projects: next });

  await mirror(sessionId, next);
  return true;
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

/**
 * Whether two link sets are the same in every field that is persisted.
 *
 * `lastTouchedAt` counts: a second write to an already-linked project moves it,
 * and skipping that write would let the timestamp drift arbitrarily far behind
 * the work it describes.
 */
const sameLinks = (a: readonly ProjectLink[], b: readonly ProjectLink[]): boolean =>
  a.length === b.length &&
  a.every((link, index) => {
    const other = b[index];
    return (
      link.path === other.path &&
      link.origin === other.origin &&
      link.isPrimary === other.isPrimary &&
      link.firstAttachedAt === other.firstAttachedAt &&
      link.lastTouchedAt === other.lastTouchedAt
    );
  });
