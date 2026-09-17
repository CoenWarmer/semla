/**
 * What a diff *is for*, as distinct from what it changed.
 *
 * The sidebar row orders itself "requirements first, outcomes after — cause
 * then effect" (session-artifacts.tsx). A plan file is neither: it is the
 * middle term, the thing an agent writes so that later turns have something
 * to implement from. Before this module a plan write was indistinguishable
 * from a source edit, so a 148-line design document sat on the row looking
 * exactly like a bug fix.
 *
 * Deliberately a `role` on an existing diff rather than a fifth
 * `ArtifactKind`. A plan genuinely *is* a diff — a reviewable file write with
 * a patch on disk — so a separate kind would either duplicate the diff or
 * replace it, and replacing it costs the review-panel click-through that
 * makes the chip worth having at all.
 *
 * Pure and client-safe, same rule as artifact-types.ts: the sidebar imports
 * this directly with no server hop, so nothing here may reach node:fs.
 *
 * ## Why two sources, kept apart
 *
 * `declared` is a fact — the agent said so on the tool call. `inferred` is a
 * guess from the file's path. They are never collapsed into a bare boolean,
 * for the same reason spec-attribution.ts keeps `same-turn` and `after`
 * apart: a heuristic that renders identically to a fact is a heuristic that
 * will eventually be read as one. The path convention is genuinely weak —
 * `docs/plans/` holds 20 files and exactly one has ever been captured as an
 * artifact, and nothing in the codebase enforces the directory — so an agent
 * writing `docs/design/foo.md` gets no role at all, which is the honest
 * outcome rather than a silently missed one.
 */

/** Roles a diff can carry. Extended by adding a case, never by widening to string. */
export type DiffRoleName = "plan";

/**
 * How confident the role is.
 *
 * `declared`: the agent passed it on the tool call. A claim it made, which is
 *   recorded verbatim and never second-guessed.
 * `inferred`: derived from the written path by `roleFromPath`. A guess, and
 *   labelled as one everywhere it surfaces.
 */
export type DiffRoleSource = "declared" | "inferred";

export interface DiffRole {
  name: DiffRoleName;
  source: DiffRoleSource;
}

/** The accepted values for a tool call's `role` argument. */
const DECLARABLE_ROLES = new Set<string>(["plan"]);

/**
 * Directory prefixes whose contents are *probably* plans.
 *
 * Kept to the one convention this repo actually shows evidence of. Adding
 * `docs/design/` or `docs/rfc/` on speculation would widen the guess without
 * widening the evidence, and a wrong role is worse than no role: an operator
 * who sees "plan" on a source file learns to distrust the label.
 */
const PLAN_PATH_PREFIXES = ["docs/plans/"] as const;

/** Normalise a path for prefix matching: forward slashes, no leading "./". */
function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * The role an agent declared on its tool call, or null.
 *
 * Unknown strings return null rather than throwing: the argument is
 * model-supplied, and a typo should cost the role, not the artifact. Trimmed
 * and lowercased because a model writing `"Plan"` means `plan`.
 */
export function roleFromDeclaration(value: unknown): DiffRole | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (!DECLARABLE_ROLES.has(normalized)) return null;
  return { name: normalized as DiffRoleName, source: "declared" };
}

/**
 * The role a written path implies, or null.
 *
 * Matches on the whole path from the project root, so a file merely
 * *mentioning* `docs/plans/` in its name does not qualify. Only ever
 * consulted as a fallback — see `resolveDiffRole`.
 */
export function roleFromPath(path: string | null): DiffRole | null {
  if (!path) return null;
  const normalized = normalizePath(path);
  const matched = PLAN_PATH_PREFIXES.some((prefix) => normalized.startsWith(prefix));
  return matched ? { name: "plan", source: "inferred" } : null;
}

/**
 * The role for one diff: what the agent declared, else what the path implies.
 *
 * Declaration wins outright. An agent that says "this is a plan" about a file
 * outside `docs/plans/` is telling us something the path cannot, and an agent
 * that declares nothing while writing into `docs/plans/` still gets the
 * weaker inferred role. When both are silent the answer is null — no role is
 * a perfectly normal state for the source edit that most diffs are.
 */
export function resolveDiffRole(input: {
  declared: unknown;
  writtenPath: string | null;
}): DiffRole | null {
  return roleFromDeclaration(input.declared) ?? roleFromPath(input.writtenPath);
}
