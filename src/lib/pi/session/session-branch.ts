/**
 * Where to move the leaf so an edited prompt replaces the one it corrects.
 *
 * Pi sessions are append-only, so editing a message cannot rewrite it. What it
 * does instead is move the leaf pointer to the edited message's *parent*: the
 * next append becomes a second child of that parent, a sibling of the original,
 * and the original — along with everything the agent said in reply to it —
 * stays on disk on a path nothing points at any more.
 *
 * The first message of a session has no parent, so there is nothing to branch
 * from. `resetLeaf()` covers that case, and Pi documents it for exactly this
 * purpose: "Use this when navigating to re-edit the first user message."
 *
 * Kept separate from session-service.ts so the rule can be tested without
 * standing up a Pi session, and so the two cases are visibly two cases rather
 * than a null check buried in a 900-line file.
 */

export type BranchTarget =
  | { kind: "root" }
  | { kind: "entry"; parentId: string };

/** An entry as far as branching cares. */
export type BranchableEntry = {
  id?: string;
  parentId?: string | null;
};

/** Raised when the entry to edit is not in the session. */
export class EntryNotFoundError extends Error {
  constructor(readonly entryId: string) {
    super(
      `No entry ${entryId} in this session. It may belong to a different ` +
        "session, or to a path that was already branched away from.",
    );
    this.name = "EntryNotFoundError";
  }
}

/**
 * Resolve the leaf move for editing `editEntryId`.
 *
 * Throws rather than falling back to appending at the end. A silent fallback
 * would answer the edited prompt while leaving the original in the context,
 * which looks like it worked and is the opposite of what was asked.
 */
export function resolveBranchTarget(
  entries: readonly BranchableEntry[],
  editEntryId: string,
): BranchTarget {
  const entry = entries.find((candidate) => candidate.id === editEntryId);
  if (!entry) throw new EntryNotFoundError(editEntryId);

  return entry.parentId
    ? { kind: "entry", parentId: entry.parentId }
    : { kind: "root" };
}

/** The two calls a branch target maps to, so callers do not re-derive them. */
export type LeafMover = {
  branch: (branchFromId: string) => void;
  resetLeaf: () => void;
};

export function applyBranchTarget(mover: LeafMover, target: BranchTarget): void {
  if (target.kind === "root") mover.resetLeaf();
  else mover.branch(target.parentId);
}
