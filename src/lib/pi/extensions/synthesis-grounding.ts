/**
 * Check a synthesis against the source it claims to summarize.
 *
 * A synthesis agent holds one tool, `commit_synthesis`, and no way to read
 * anything — so whatever it writes is either in its source packet or invented.
 * One run produced a page asserting "Presence of Dockerfile.pi and
 * docker-compose.pi.yml" and a described `src/` component layout from a packet
 * holding four config files, none of which mention Docker or a directory tree.
 * The claims were true of the repo and traceable to nothing, which is the
 * failure this vault exists to prevent, and it took a manual audit to notice.
 *
 * Entities are not worth checking — they were all grounded in that run, because
 * naming a library is the easy part. Prose is where a synthesis drifts.
 */

/** A takeaway below this share of its own distinctive words is reported. */
export const GROUNDING_THRESHOLD = 0.5;

/**
 * Words too generic to tie a sentence to a source. Deliberately short: the aim
 * is a signal, and every word left in makes a fabricated line easier to spot.
 */
const STOP_WORDS = new Set([
  "which", "their", "there", "these", "those", "about", "using", "under",
  "while", "where", "other", "through", "across", "being", "after", "before",
  "above", "includes", "including", "indicates", "appears", "reveals",
  "standard", "project", "multiple", "several", "files", "folders",
]);

/**
 * Distinctive words in a line: five characters or more, deduplicated. Shorter
 * tokens match too much — "pi" and "js" appear in almost any packet.
 */
export function distinctiveWords(text: string): string[] {
  return [...new Set(text.toLowerCase().match(/[a-z0-9]{5,}/g) ?? [])].filter(
    (word) => !STOP_WORDS.has(word),
  );
}

/** Share of a line's distinctive words that appear in the source. */
export function coverage(text: string, sourceText: string): number {
  const words = distinctiveWords(text);
  if (words.length === 0) return 1;
  const haystack = sourceText.toLowerCase();
  return words.filter((word) => haystack.includes(word)).length / words.length;
}

export type GroundingReport = {
  /** Takeaways whose coverage fell below the threshold, worst first. */
  ungrounded: Array<{ text: string; coverage: number }>;
  /** Lowest coverage across all takeaways; 1 when there are none. */
  lowest: number;
};

/**
 * Report the takeaways a source does not support.
 *
 * Measured against the packet the agent was given, so truncation counts as
 * "not in the source" — a claim drawn from past the cut is as untraceable as
 * an invented one.
 */
export function groundingReport(
  takeaways: readonly string[],
  sourceText: string,
): GroundingReport {
  const scored = takeaways.map((text) => ({ text, coverage: coverage(text, sourceText) }));
  return {
    ungrounded: scored
      .filter((item) => item.coverage < GROUNDING_THRESHOLD)
      .sort((left, right) => left.coverage - right.coverage),
    lowest: scored.reduce((low, item) => Math.min(low, item.coverage), 1),
  };
}
