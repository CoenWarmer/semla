/**
 * What a step in the strip cost, and the honest version of that sentence.
 *
 * There is no per-tool-call usage to report, anywhere. Pi records usage on the
 * `assistant` message that made the calls — `{input, output, cacheRead,
 * cacheWrite, reasoning, totalTokens, cost}` — and a `toolResult` entry carries
 * `content`, `isError`, `toolName` and `details` and nothing else. So a tool
 * call's own token spend is not a number this application has; dividing the
 * turn's figure by its call count would invent one.
 *
 * It is a near-exact proxy regardless. In a real 111-turn session on disk
 * (.semla-sessions/00aebdb3…), 105 assistant turns made exactly one tool call,
 * four made none and two made two. So for almost every dot the turn's usage
 * *is* that call's usage, and the only thing needed is to say so where it is
 * not: `callsInTurn` is carried alongside, and the readout names it whenever a
 * turn made more than one call. The reader can then see that two dots share a
 * figure rather than each having earned it.
 */

import { formatCost, formatTokens } from "@/components/token-usage";

/** The usage of the turn a step belongs to, with the sharing made explicit. */
export type StepTurnUsage = {
  /** Dollar cost the turn reported. */
  cost: number;
  /** Total tokens the turn reported. */
  tokens: number;
  /**
   * Tool calls the turn made that are drawn in the strip. 1 means the figures
   * above belong to this step alone; more means they are shared.
   */
  callsInTurn: number;
};

/**
 * "12.6k · $0.031" — or the same with a note that the turn's two calls share
 * it. Undefined when there is no usage worth showing, so a caller can skip the
 * line rather than render "0".
 */
export function describeStepUsage(usage: StepTurnUsage | undefined): string | undefined {
  if (!usage) return undefined;

  const parts: string[] = [];
  if (usage.tokens > 0) parts.push(`${formatTokens(usage.tokens)} tokens`);
  if (usage.cost > 0) parts.push(formatCost(usage.cost));
  if (parts.length === 0) return undefined;

  const figures = parts.join(" · ");

  return usage.callsInTurn > 1
    ? `${figures} for this turn (${usage.callsInTurn} calls)`
    : figures;
}
