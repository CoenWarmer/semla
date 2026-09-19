/**
 * Rebuilding the system prompt's skills section from a filtered skill list.
 *
 * There is no "hide skill X" API. Skills are discovered once from
 * `additionalSkillPaths` and rendered into the prompt by `buildSystemPrompt`,
 * so the only lever is `before_agent_start`, which hands over the assembled
 * `systemPrompt` and accepts a replacement. Filtering therefore means finding
 * the block that `formatSkillsForPrompt` emitted and substituting a narrower
 * one.
 *
 * **Why the block is replaced by delimiter rather than re-assembled.**
 * Re-running `buildSystemPrompt` with a filtered `skills` array would be the
 * obvious approach and is worse: `systemPromptOptions` is what Pi *started*
 * from, and other extensions' `before_agent_start` handlers chain onto the
 * prompt — the SDK says so explicitly — so rebuilding from options would
 * discard whatever ran before this. Cutting out one delimited region preserves
 * every other contribution, including ones this file does not know exist.
 *
 * **Why it is conservative about not finding the block.** If the markers are
 * absent — a `customPrompt` with no skills section, a future Pi that formats
 * them differently — this returns the prompt untouched and says so. A silently
 * different system prompt is the failure mode plan §5 singles out as the
 * reason skill gating ships separately from tool gating: a missing tool is
 * loud, a missing instruction is not.
 */

import { formatSkillsForPrompt, type Skill } from "@earendil-works/pi-coding-agent";

/**
 * The delimiters `formatSkillsForPrompt` writes. Restated from the SDK's
 * `core/skills.ts` because they are string literals inside a function, not
 * exported constants — `skills-prompt.test.ts` asserts the real formatter
 * still emits them, so a change upstream fails there rather than here.
 */
const OPEN_TAG = "<available_skills>";
const CLOSE_TAG = "</available_skills>";

export interface SkillsRewrite {
  /** The rewritten prompt, or the original when nothing was changed. */
  systemPrompt: string;
  /** Whether the skills block was found and replaced. */
  rewritten: boolean;
  /** Names dropped from the prompt. Empty when nothing was removed. */
  removed: string[];
  /** Why no rewrite happened, when `rewritten` is false. */
  reason?: string;
}

/**
 * Replace the prompt's skills section with only `keep`.
 *
 * `skills` must be the full discovered list — the same one Pi rendered — since
 * the replacement block is built from it rather than parsed back out of the
 * prompt text. Parsing would have to un-escape the XML the formatter escaped,
 * and a skill whose description contains an ampersand would not survive the
 * round trip.
 */
export function rewriteSkillsSection(
  systemPrompt: string,
  skills: readonly Skill[],
  keep: readonly string[],
): SkillsRewrite {
  const start = systemPrompt.indexOf(OPEN_TAG);
  const end = systemPrompt.indexOf(CLOSE_TAG);
  if (start === -1 || end === -1 || end < start) {
    return {
      systemPrompt,
      rewritten: false,
      removed: [],
      reason: "no skills section in the assembled prompt",
    };
  }

  const kept = new Set(keep);
  // Only skills Pi would itself have rendered can be removed from the
  // rendered block; a disableModelInvocation skill was never in it.
  const visible = skills.filter((skill) => !skill.disableModelInvocation);
  const removed = visible.filter((skill) => !kept.has(skill.name)).map((skill) => skill.name);
  if (removed.length === 0) {
    return { systemPrompt, rewritten: false, removed: [], reason: "nothing to remove" };
  }

  const remaining = skills.filter((skill) => kept.has(skill.name));
  const before = systemPrompt.slice(0, start);
  const after = systemPrompt.slice(end + CLOSE_TAG.length);

  if (remaining.length === 0) {
    // The formatter returns "" for an empty list, which would leave the
    // preamble sentences ("The following skills provide...") pointing at
    // nothing. Those sentences precede OPEN_TAG, so they are cut here by
    // trimming back to the text before them rather than left dangling.
    return {
      systemPrompt: `${trimSkillsPreamble(before)}${after}`,
      rewritten: true,
      removed,
    };
  }

  // formatSkillsForPrompt leads with its own preamble and blank lines, which
  // are already present in `before`; only the tag-delimited part is wanted.
  const formatted = formatSkillsForPrompt(remaining as Skill[]);
  const innerStart = formatted.indexOf(OPEN_TAG);
  const innerEnd = formatted.indexOf(CLOSE_TAG);
  if (innerStart === -1 || innerEnd === -1) {
    return {
      systemPrompt,
      rewritten: false,
      removed: [],
      reason: "formatSkillsForPrompt emitted no recognisable skills block",
    };
  }
  const block = formatted.slice(innerStart, innerEnd + CLOSE_TAG.length);

  return { systemPrompt: `${before}${block}${after}`, rewritten: true, removed };
}

/**
 * The first line of the preamble the formatter writes before the open tag.
 * Used only to cut it when no skills survive.
 */
const PREAMBLE_FIRST_LINE =
  "The following skills provide specialized instructions for specific tasks.";

function trimSkillsPreamble(before: string): string {
  const index = before.indexOf(PREAMBLE_FIRST_LINE);
  // Left as-is when absent: dropping an unknown amount of prompt to tidy up
  // would be a bigger change than the stray sentence it is avoiding.
  return index === -1 ? before : before.slice(0, index).trimEnd();
}
