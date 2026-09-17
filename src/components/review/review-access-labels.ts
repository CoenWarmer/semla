/**
 * Turning an access highlight into the labels drawn above its lines.
 *
 * Separate from the widget that draws them for the same reason
 * `review-decorations.ts` is separate from the decorations effect: the
 * interesting decisions here — where a label anchors, what it says, and what a
 * whole-file read is supposed to look like — are arithmetic over the access,
 * and arithmetic is worth testing without a Monaco instance in the room.
 *
 * One label per range rather than one per access. A `read` given several
 * offsets produces several disjoint bands, and a single label above the first
 * of them would attribute the others to nothing — the question the marks exist
 * to answer is "what caused *these* lines to be read", and that has to be
 * answerable at every band.
 */

import { MAIN_AGENT, type AccessAgent } from "@/lib/pi/file-access/access-types";

import type { AccessHighlight } from "./review-panel-request";

/**
 * The agent to name in a label, or null for the host agent.
 *
 * Compared on `id`, not on the label: a subagent is free to be called "Main"
 * and the host agent's id is the one fixed thing (`MAIN_AGENT`).
 */
export function agentLabelFor(agent: AccessAgent): string | null {
  return agent.id === MAIN_AGENT.id ? null : agent.label;
}

export interface AccessLabel {
  /** Stable within one `set()` call; the anchor line is what identifies it. */
  key: string;
  /** 1-based line the label anchors above. */
  line: number;
  /** What the operator reads: tool name, and the agent when not the host. */
  text: string;
  kind: "read" | "write";
  /** The path was parsed out of a shell command rather than an argument. */
  inferred: boolean;
}

/**
 * The label's text.
 *
 * Tool name first, because that is the thing being attributed and the thing
 * the operator is scanning for. The agent is appended only when one was
 * supplied — see `AccessHighlight.agent`, which is null for the host agent,
 * since "read · Main" on every band in a session with no subagents is noise
 * that trains the eye to ignore the label.
 *
 * A `bash` access carries the shell verb too (`AccessHighlight.via`), rendered
 * as "bash – sed". `bash` alone was the least informative label the panel drew:
 * three quarters of this agent's tool calls are shell commands, so it named the
 * transport and not the action, and the operator still had to go to the
 * scrubber to find out whether the file had been paged through with `sed` or
 * merely matched by `rg`. The verb is separated with a dash rather than the
 * middot the other parts use, because it qualifies the tool rather than
 * standing beside it — "bash – sed · researcher" parses on sight where
 * "bash · sed · researcher" reads as three peers.
 */
function labelText(
  tool: string,
  via: string | null,
  agent: string | null,
  wholeFile: boolean,
) {
  const parts = [via ? `${tool} – ${via}` : tool];
  if (agent) parts.push(agent);
  if (wholeFile) parts.push("whole file");
  return parts.join(" · ");
}

/**
 * Where a label may anchor.
 *
 * Clamped into the model the same way the access decorations are, and for the
 * same reason: a range recorded against a longer version of the file would
 * otherwise anchor a widget off the end of the model.
 */
function clamp(line: number, lineCount: number) {
  return Math.min(Math.max(1, line), lineCount);
}

/**
 * The labels for one access.
 *
 * A whole-file access (`ranges: []`) gets exactly one label, at line 1, said
 * out loud as "whole file". Nothing is highlighted in that case — the
 * decorations effect returns early — so without this the strongest signal in
 * the panel, an entire file the agent read, would be the only one carrying no
 * attribution at all.
 *
 * Two ranges that clamp onto the same line collapse to one label rather than
 * stacking two widgets Monaco would draw on top of each other.
 */
export function buildAccessLabels(
  access: AccessHighlight | null,
  lineCount: number,
): AccessLabel[] {
  if (!access || lineCount < 1) return [];

  const lines =
    access.ranges.length === 0
      ? [1]
      : access.ranges.map((range) => clamp(range.start, lineCount));

  const seen = new Set<number>();
  const labels: AccessLabel[] = [];

  for (const line of lines) {
    if (seen.has(line)) continue;
    seen.add(line);
    labels.push({
      inferred: access.inferred,
      key: `${access.kind}-${line}`,
      kind: access.kind,
      line,
      text: labelText(
        access.tool,
        access.via,
        access.agent,
        access.ranges.length === 0,
      ),
    });
  }

  return labels;
}
