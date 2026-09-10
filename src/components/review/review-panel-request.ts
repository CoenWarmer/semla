/**
 * What the review panel is currently showing, and who asked for it.
 *
 * The panel used to read its target once, on mount, and the caller remounted it
 * for every new pick. That was tenable while the element picker was the only
 * caller. It is not tenable now: the scrubber changes the target several times
 * a second, and a remount throws away unsaved drafts, the hunk accordion, the
 * commit message and the editor's scroll position each time.
 *
 * Three sources ask for a file — the element picker (a prop), the scrubber, and
 * a click in the sidebar — and the rule between them is "most recent wins".
 * Expressed here as a derivation rather than an effect that syncs a prop into
 * state, because `react/set-state-in-effect` is an error in this repository and
 * because the synced copy is a second source of truth that can disagree.
 *
 * The mechanism is `overNonce`: a request the panel made itself records which
 * external target was in force at the time. When a newer target arrives its
 * nonce no longer matches, and the panel's own request stops applying without
 * anything having to clear it.
 */

import type { LineRange } from "@/lib/pi/file-access/access-types";

import type { FileSelection } from "./review-changed-files";
import type { Reveal } from "./review-initial-reveal";

/** Lines to mark in the editor as read or written by the agent. */
export interface AccessHighlight {
  kind: "read" | "write";
  /** Empty means the whole file was touched; nothing is marked. */
  ranges: readonly LineRange[];
  /** Shown in the gutter hover, so a guess is labelled as one. */
  inferred: boolean;
}

/** Where the panel should open, from outside it. */
export interface PanelTarget {
  project: string;
  path: string;
  line?: number;
  precision?: "exact" | "component";
  /** Unique per request, including a repeat of the same file and line. */
  nonce: number;
}

export interface PanelRequest {
  /** The file in the editor. Null when a project with no changes is selected. */
  selection: FileSelection | null;
  /** The changed file whose hunks are folded open. */
  expanded: FileSelection | null;
  reveal: Reveal | null;
  highlight: AccessHighlight | null;
  precision: "exact" | "component" | null;
  /** The external target nonce this request was made against. */
  overNonce: number;
}

export const BLANK_REQUEST: PanelRequest = {
  expanded: null,
  highlight: null,
  overNonce: 0,
  precision: null,
  reveal: null,
  selection: null,
};

/**
 * The request an external target implies, or null when there is no target.
 *
 * The reveal's nonce is the target's own, so two picks of the same line are two
 * distinct reveals — which is what makes "jump me back there" work — while a
 * re-render with an unchanged target produces an equal object and does not
 * re-scroll the editor.
 */
export function requestForTarget(
  target: PanelTarget | null | undefined,
): PanelRequest | null {
  if (!target) return null;

  const selection = { path: target.path, project: target.project };

  return {
    expanded: selection,
    highlight: null,
    overNonce: target.nonce,
    precision: target.precision ?? null,
    // No line means "open this file", not "scroll to line 1" — the editor's
    // own open-on-the-first-hunk behaviour is the useful landing place, and a
    // reveal would override it. See review-initial-reveal.ts.
    reveal:
      target.line === undefined
        ? null
        : { line: target.line, nonce: target.nonce },
    selection,
  };
}

/**
 * Which request applies: the panel's own, or the one the target implies.
 *
 * A panel request made before the current target is stale by construction, so
 * this is the whole of the precedence rule.
 */
export function activeRequest(
  own: PanelRequest | null,
  target: PanelTarget | null | undefined,
): PanelRequest {
  const nonce = target?.nonce ?? 0;
  if (own && own.overNonce === nonce) return own;
  return requestForTarget(target) ?? BLANK_REQUEST;
}

/** A reveal for `line`, distinct from whatever the base request asked for. */
export function nextReveal(base: PanelRequest, line: number): Reveal {
  return { line, nonce: (base.reveal?.nonce ?? 0) + 1 };
}
