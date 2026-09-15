/**
 * The `customType` pi-llm-wiki stamps on its per-turn auto-recall injection.
 *
 * Mirrors `WIKI_RECALL_MESSAGE_TYPE` in
 * `@zosmaai/pi-llm-wiki`'s `extensions/llm-wiki/lib/inject.ts` — restated here
 * rather than imported because that module is loaded by jiti as a path
 * extension (see AGENTS.md's "Extensions are imported, not pointed at"), not
 * through Node's module resolution, so nothing in this tree can `import` it.
 *
 * The wiki's `before_agent_start` hook appends this as a `role: "custom"`
 * entry (`type: "custom_message"` once on disk) with `display: false` — a
 * signal for the *TUI* to hide the bubble, not a signal that Semla's own
 * transcript should drop it. `session-file.ts` and `transcript.ts` used to
 * filter to `entry.type === "message"` only, which excluded every
 * `custom_message` entry categorically — the recall content reached the model
 * on every turn but left no trace a user could inspect on reload. See the
 * `wikiRecall` field threaded through `SessionTranscriptEntry`.
 */
export const WIKI_RECALL_CUSTOM_TYPE = "wiki-recall-context";

/**
 * `customType` for pi-llm-wiki's one-shot "wiki active" session banner. Not
 * currently surfaced in the transcript — it duplicates the extension's own
 * chat message and carries no per-turn evidence — but named here so a future
 * caller does not have to rediscover the string.
 */
export const WIKI_SESSION_NOTICE_CUSTOM_TYPE = "wiki-session-notice";
