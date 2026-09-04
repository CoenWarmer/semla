/**
 * Resolving a leaf someone *named* to the leaf they meant.
 *
 * A leaf named from outside — a stored default, a request parameter, a shared
 * link — points at one entry, but conversation may have continued past it
 * since: further replies appended as its child, its child's child, and so on.
 * Resolving to that exact entry would silently truncate a branch that has
 * grown, which is why `resolveLeafOverride` walks forward from the named entry
 * to whatever sits at the end of it now, taking the most recently appended
 * child at each step — "the tip of the branch this entry is on", not "this
 * entry". See docs/plans/branching-sessions.md §6, "a shared ?leaf= link goes
 * stale as that branch grows".
 *
 * An id nothing in the session recognises resolves to undefined rather than
 * throwing. Every caller here already has a defined fallback for "no leaf
 * given" — the last entry in the file, the same one Pi itself would pick — so
 * failing outright over a stale or cross-session reference would be a worse
 * outcome than quietly falling back to it. session-path.ts carries the
 * contract this must not break: choosing a leaf other than the one named, or
 * the default, would put the UI out of step with the model.
 */
import type { PathEntry } from "@/lib/pi/session-path";

export function resolveLeafOverride<T extends PathEntry>(
  entries: readonly T[],
  requestedId: string | null | undefined,
): string | undefined {
  if (!requestedId) return undefined;

  const byId = new Map<string, T>();
  for (const entry of entries) {
    if (entry.id) byId.set(entry.id, entry);
  }
  // Unknown entirely — a different session's id, or a stale one from a file
  // that was rewritten. Fall back rather than pin a dangling reference.
  if (!byId.has(requestedId)) return undefined;

  const childrenByParent = new Map<string, T[]>();
  for (const entry of entries) {
    if (!entry.parentId) continue;
    const group = childrenByParent.get(entry.parentId);
    if (group) group.push(entry);
    else childrenByParent.set(entry.parentId, [entry]);
  }

  let current = requestedId;
  // A malformed file could contain a parent cycle; refusing to revisit an
  // entry turns that into "stop here" rather than a hang.
  const seen = new Set<string>();
  while (!seen.has(current)) {
    seen.add(current);
    const children = childrenByParent.get(current);
    if (!children || children.length === 0) break;
    current = children[children.length - 1]!.id as string;
  }

  return current;
}
