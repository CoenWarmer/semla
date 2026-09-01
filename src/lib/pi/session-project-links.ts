/**
 * Pure operations on a session's project links.
 *
 * Kept apart from the stores that persist them because there are two — the
 * disk record and the Postgres mirror — and the rules about what a link means
 * must not be written twice. Everything here takes a list and returns a new
 * one; nothing reads a file or a database.
 *
 * Free of node imports, so a client component can order and read links without
 * dragging the runtime in. See client-boundary.test.ts for why that matters.
 */

import type { ProjectLink } from "@/lib/pi/session-meta";

export type { ProjectLink };

/** The anchor's path, or null when a session has links but no anchor. */
export function primaryPath(links: readonly ProjectLink[]): string | null {
  return links.find((link) => link.isPrimary)?.path ?? null;
}

/**
 * Links in display order: the anchor, then the rest oldest first.
 *
 * Oldest first rather than most-recently-touched, because the list is a record
 * of how the session grew. Reordering it as the agent works would make the
 * badges shuffle under the reader mid-turn.
 */
export function orderLinks(links: readonly ProjectLink[]): ProjectLink[] {
  return [...links].sort((a, b) => {
    if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
    if (a.firstAttachedAt !== b.firstAttachedAt) {
      return a.firstAttachedAt.localeCompare(b.firstAttachedAt);
    }
    return a.path.localeCompare(b.path);
  });
}

/**
 * Add `path` to the list, or refresh the link that is already there.
 *
 * Two rules that are easy to get backwards:
 *
 * `origin` only ever strengthens. A project the user chose *and* the agent
 * wrote to stays `explicit`, because the choice is the stronger statement and
 * it is what decides whether the link can be removed. An observed write must
 * never quietly turn a removable link into a permanent one.
 *
 * A session with no anchor adopts the first project attached to it. That is
 * what lets a session started from `/sessions/new` — which names no project at
 * all — acquire one the moment the agent writes somewhere, instead of staying
 * anchorless forever.
 */
export function attachProject(
  links: readonly ProjectLink[],
  attach: {
    path: string;
    origin: ProjectLink["origin"];
    at: string;
    /** Make this the anchor, moving it off whichever link holds it now. */
    primary?: boolean;
  },
): ProjectLink[] {
  const { at, origin, path } = attach;
  const existing = links.find((link) => link.path === path);
  const primary = attach.primary === true || primaryPath(links) === null;

  const next: ProjectLink[] = existing
    ? links.map((link) =>
        link.path === path
          ? {
              ...link,
              // Never downgrade: explicit outranks observed.
              origin: link.origin === "explicit" ? "explicit" : origin,
              lastTouchedAt: at,
            }
          : link,
      )
    : [
        ...links,
        {
          path,
          origin,
          isPrimary: false,
          firstAttachedAt: at,
          lastTouchedAt: at,
        },
      ];

  return orderLinks(primary ? setPrimaryIn(next, path) : next);
}

/**
 * Move the anchor to `path`.
 *
 * A path that is not linked is left alone rather than added: promoting
 * something the session has no relationship with would invent a link, and the
 * caller asking for it has a bug worth surfacing as a 404 rather than papering
 * over.
 */
export function setPrimary(
  links: readonly ProjectLink[],
  path: string,
): ProjectLink[] {
  if (!links.some((link) => link.path === path)) return [...links];
  return orderLinks(setPrimaryIn(links, path));
}

const setPrimaryIn = (
  links: readonly ProjectLink[],
  path: string,
): ProjectLink[] =>
  links.map((link) => ({ ...link, isPrimary: link.path === path }));

/**
 * Remove an explicitly-attached project.
 *
 * Observed links are refused. They are a record of the agent having written
 * somewhere, and a log you can edit is not a log — this is the same reasoning
 * that makes the whole relation worth storing. Returns null so the caller can
 * answer 409 rather than pretending the removal happened.
 *
 * Removing the anchor leaves the session without one. The next attach adopts a
 * new anchor, and until then the UI simply has nothing to point at, which is
 * the same state a session created from `/sessions/new` starts in.
 */
export function detachProject(
  links: readonly ProjectLink[],
  path: string,
): ProjectLink[] | null {
  const existing = links.find((link) => link.path === path);
  if (!existing) return [...links];
  if (existing.origin !== "explicit") return null;

  return orderLinks(links.filter((link) => link.path !== path));
}
