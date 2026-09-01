/**
 * Applying a change to a session's project links, on disk and in the mirror.
 *
 * Four callers mutate links — the agent writing to a repo, and the user
 * attaching, promoting or detaching one — and all four need the same sequence:
 * read the record, apply the change, write disk, mirror to Postgres, and skip
 * the last two when nothing actually moved. Written once here so the ordering
 * and the skip cannot drift between them.
 *
 * The disk write is the one that has to succeed. See session-project-mirror.ts
 * for why a failure past that point is swallowed.
 */

import { readSessionMeta, writeSessionMeta, type ProjectLink } from "@/lib/pi/session-meta";
import { mirrorSessionProjects } from "@/lib/pi/session-project-mirror";

/**
 * A change to a link list.
 *
 * Returning `null` refuses the change — detaching a link the agent earned, for
 * instance — so the caller can answer 409 rather than report a success that did
 * not happen.
 */
export type LinkUpdate = (
  links: readonly ProjectLink[],
) => ProjectLink[] | null;

export type UpdateResult =
  /** The session has no record on disk. */
  | { status: "missing" }
  /** The update declined to make the change. */
  | { status: "refused" }
  /** Applied, or already true — `changed` says which. */
  | { status: "ok"; links: ProjectLink[]; changed: boolean };

export async function updateSessionProjects(
  sessionId: string,
  update: LinkUpdate,
  options: {
    dir?: string;
    mirror?: (id: string, links: readonly ProjectLink[]) => Promise<void>;
  } = {},
): Promise<UpdateResult> {
  const { dir, mirror = mirrorSessionProjects } = options;

  const meta = dir ? readSessionMeta(sessionId, dir) : readSessionMeta(sessionId);
  if (!meta) return { status: "missing" };

  const next = update(meta.projects);
  if (next === null) return { status: "refused" };

  if (sameLinks(meta.projects, next)) {
    return { changed: false, links: meta.projects, status: "ok" };
  }

  // Disk first, and synchronously, so the read-modify-write cannot interleave
  // with another writer. See writeSessionMeta on why that synchrony is
  // load-bearing rather than incidental.
  if (dir) writeSessionMeta(sessionId, { projects: next }, dir);
  else writeSessionMeta(sessionId, { projects: next });

  await mirror(sessionId, next);
  return { changed: true, links: next, status: "ok" };
}

/**
 * Whether two link sets are the same in every persisted field.
 *
 * `lastTouchedAt` counts: a second write to an already-linked project moves it,
 * and treating that as "no change" would let the timestamp drift arbitrarily
 * far behind the work it describes.
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
