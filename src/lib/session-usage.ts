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
  /** Per workflow run id. */
  runs: Record<string, SessionUsage>;
  /**
   * Workflow usage recovered from the backup for a session that predates
   * per-run stamping.
   *
   * A field of its own rather than a reserved key in `runs`, because it is not
   * a run: the aggregate the mirror can answer has no per-run breakdown. It
   * cannot double count either — those runs are finished, so nothing will
   * stamp them again, and a later run is added under its own id.
   */
  priorRuns?: SessionUsage;
};

export const EMPTY_USAGE_RECORD: SessionUsageRecord = {
  conversation: NO_USAGE,
  runs: {},
};

/** The number both the sidebar and the top bar show. */
export const sessionUsageTotal = (
  record: SessionUsageRecord | undefined,
): SessionUsage =>
  record
    ? addUsage(
        record.conversation,
        record.priorRuns,
        ...Object.values(record.runs),
      )
    : NO_USAGE;
