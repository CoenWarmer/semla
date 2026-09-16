/**
 * The per-turn drift nudge, as sentences for the system prompt.
 *
 * **Why here and not in a turn counter.** The obvious precedent is
 * `client-session-component.tsx`, which fires a context-quality check after
 * every tenth user prompt. That is client React state with no store and no
 * server counter, so a check built on it only runs while somebody has the
 * session open — for a harness that runs turns headlessly, a staleness check
 * that depends on a mounted panel is not a staleness check.
 * `buildMemoryContextBlock` is rebuilt server-side on every prompt, so it needs
 * no counter at all.
 *
 * **Only the anchor project.** A session can be attached to several, and
 * checking all of them multiplies the git subprocesses by the project count on
 * the hot path before the model sees anything. The anchor is the one the
 * prompt already claims is active and the one every phase's status is keyed
 * to.
 *
 * **Never throws, never rejects.** It runs while assembling a prompt. A
 * missing project directory, a git binary that is not there, an unreadable
 * status file: every one of those degrades to no nudge, which is exactly the
 * pre-existing behaviour. Failing a turn to report that a wiki might be out of
 * date would be a worse bug than the one this exists to prevent.
 *
 * Cost, since §10 of the plan asks for it to be confirmed rather than assumed:
 * two `git` subprocesses, two small JSON reads, and phase 3's ~25 stat/reads
 * of manifests and tool configs. Phase 1's tree enumeration is deliberately
 * not included — see index-status.ts.
 */

import { isAbsolute, join } from "node:path";

import { PI_WORKSPACE_ROOT } from "@/lib/pi/runtime/runtime-config";

import { collectOrientStaleness, describeStalePhases } from "./staleness";

/**
 * Stale-phase sentences for the session's anchor project, or an empty array.
 *
 * @param projects Workspace-relative project paths, anchor first.
 */
export async function orientDriftSentences(
  projects: readonly string[],
): Promise<string[]> {
  const anchor = projects[0];
  if (anchor === undefined || anchor.length === 0) return [];

  const root = isAbsolute(anchor) ? anchor : join(PI_WORKSPACE_ROOT, anchor);

  try {
    const report = await collectOrientStaleness({ root });
    return describeStalePhases(report);
  } catch (error) {
    // Logged, not surfaced: the prompt is still correct without the nudge, and
    // a silent catch here would hide a real regression in the check itself.
    console.error("[orient-status] Unable to compute orientation drift:", error);
    return [];
  }
}
