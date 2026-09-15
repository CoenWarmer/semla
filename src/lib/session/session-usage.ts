/**
 * What a session cost, and the one rule both places that show it must agree on.
 *
 * A session spends tokens in two places: the main conversation, and the
 * subagents its workflows run. **Neither is a substitute for the other**, and
 * writing it down here is the point of this module — the top bar and the
 * sidebar each computed a total, and they disagreed by an order of magnitude
 * on a real session (10,723 subagent tokens against roughly 1,045 in the
 * conversation) because one reported only the workflows and the other only
 * the conversation.
 *
 * They cannot double count. `ensurePiSession` upserts on
 * `onConflict: "semla_session_id"`, so a Semla session has exactly one
 * `pi_sessions` row, and only `runPiPrompt` writes one — a workflow subagent
 * never gets one, and its usage is therefore absent from the entries the
 * conversation total is summed from. The two sets are disjoint by
 * construction.
 */

export type SessionUsage = { cost: number; tokens: number };

export const NO_USAGE: SessionUsage = { cost: 0, tokens: 0 };

/**
 * Add usage from every source a session has.
 *
 * A named function rather than `a + b` at each call site, so the *decision* to
 * sum lives somewhere a reader can find it. The bug this replaces was
 * `runTokens > 0 ? runTokens : msgTokens`, which reads like a fallback and
 * behaves like discarding half the bill.
 */
export const addUsage = (
  ...parts: readonly (SessionUsage | undefined)[]
): SessionUsage =>
  parts.reduce<SessionUsage>(
    (total, part) => ({
      cost: total.cost + (part?.cost ?? 0),
      tokens: total.tokens + (part?.tokens ?? 0),
    }),
    NO_USAGE,
  );

/**
 * A session's usage as recorded on disk.
 *
 * Split, and the runs keyed by id, so a stamp is idempotent: a run's snapshot
 * is persisted many times as it progresses, and adding each one to a running
 * total would count the same run over and over. Writing it under its id makes
 * the last write the truth.
 */
export type SessionUsageRecord = {
  conversation: SessionUsage;
  /**
   * The workflow half, and only for a session with no run index on disk.
   *
   * Where the index exists the run files answer this, and they are both
   * fresher and complete: the `workflow_runs` snapshot column is kept current
   * only for foreground runs, so a background run is recorded there as it
   * stood partway through. This field is the recovered aggregate for sessions
   * that predate the index, which is the one case disk cannot answer.
   */
  priorRuns?: SessionUsage;
};

export const EMPTY_USAGE_RECORD: SessionUsageRecord = {
  conversation: NO_USAGE,
};

/** The number both the sidebar and the top bar show. */
export const sessionUsageTotal = (
  record: SessionUsageRecord | undefined,
): SessionUsage =>
  record ? addUsage(record.conversation, record.priorRuns) : NO_USAGE;
