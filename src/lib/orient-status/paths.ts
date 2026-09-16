/**
 * Where a project's orient status lives on disk.
 *
 * Rooted at an overridable home for the reason index-paths.ts records: state
 * keyed by a `mkdtemp` cwd but rooted at the real home directory outlives the
 * temp directory it describes, and nothing collects it — 1,931 directories and
 * 127 MB in `~/.pi/workflows/projects`. These files are a handful of scalars,
 * so the exposure is directory count rather than bytes, but the mechanism is
 * identical and the fix is one env var.
 *
 * `projectKey` is imported from code-index rather than copied. index-paths.ts's
 * docblock argues against importing `workflowProjectKey`, but its objection is
 * specifically that `src/lib/` should not depend on a vendored extension tree;
 * one src/lib module importing another is not that. The coupling is still real
 * and its failure is silent — change the derivation there and every existing
 * status directory orphans, so orient reports never-run for a repo it oriented
 * yesterday. Two cheap things make it loud instead: the derivation is pinned by
 * a test, and every status file carries the absolute `root` it describes, so an
 * orphan is identifiable rather than merely absent.
 *
 * Not under `projectIndexDir(key)`: orient status is not code-index state, and
 * nesting it there would put it inside a directory the indexer may clear.
 */

import { homedir } from "node:os";
import { join } from "node:path";

import { projectKey } from "@/lib/code-index/index-paths";

/** Root of all orient status, overridable via SEMLA_ORIENT_HOME. */
export function orientStatusHomeDir(): string {
  // Read per call, not captured at import, so a test can point it somewhere
  // disposable without controlling module load order.
  return process.env.SEMLA_ORIENT_HOME ?? join(homedir(), ".semla", "orient");
}

/** Directory holding one project's orient status files. */
export function orientStatusDir(projectRoot: string): string {
  return join(orientStatusHomeDir(), projectKey(projectRoot));
}

export interface OrientStatusPaths {
  dir: string;
  /** WikiStatus: capture time, commit sha, dirty flag. See wiki-status.ts. */
  wiki: string;
  /** VerificationStatus: capture time, inputs digest, signals. */
  verification: string;
}

/**
 * One file per phase, not one file per project.
 *
 * The plan's first draft had all three phases read-modify-writing a single
 * `status.json` and asserted this meant one phase's run never clobbers
 * another's. Without mutual exclusion it means precisely the opposite, and this
 * repository has already paid for that lesson once, in wiki-vault-lock.ts:
 * two captures that both list before either writes get the same source id, and
 * the second packet overwrites the first, with nothing erroring.
 *
 * `withVaultLock` would work and is still the wrong answer. A lock is needed
 * because two writers share one record; these writers share nothing. One file
 * each means no critical section, no stale-lock timeout to tune, and no
 * failure mode to test for. A single file would only pay off if some reader
 * needed all phases consistent at one instant, and none does — staleness is
 * checked per phase.
 */
export function orientStatusPaths(projectRoot: string): OrientStatusPaths {
  const dir = orientStatusDir(projectRoot);
  return {
    dir,
    verification: join(dir, "verification.json"),
    wiki: join(dir, "wiki.json"),
  };
}
