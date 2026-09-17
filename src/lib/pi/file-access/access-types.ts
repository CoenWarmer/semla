/**
 * What the agent read and wrote, as a record the UI can step through.
 *
 * Derived on the server from the session file rather than from the transcript
 * the client already has, because the transcript is lossy in exactly the places
 * this needs: `getParams` keeps only scalar arguments, and `buildTranscript`
 * never reads `details` at all — so an `edit`'s `firstChangedLine` and a
 * `code_resolve`'s resolved symbol, both of which *are* on disk, never reach the
 * browser. Resolving here also puts the workspace root, the agent cwd and the
 * project links in the same place, which is the only place they all exist.
 *
 * See docs/plans/file-access-scrubber.md.
 */

/**
 * A span of lines, 1-based and inclusive.
 *
 * `end: null` means "to the end of the file" — a `read` given an `offset` and
 * no `limit` reads to EOF, and inventing a number for that would be a lie the
 * editor would then highlight.
 */
export interface LineRange {
  start: number;
  end: number | null;
}

export interface AccessSymbol {
  name: string;
  line: number;
  /** Pi's own kind string — "Function", "Class", … — passed through unread. */
  kind: string;
}

/** Which agent made the access. The host agent is `main`. */
export interface AccessAgent {
  /** `main`, or `<runId>:<agentId>` for a workflow subagent. */
  id: string;
  label: string;
}

/**
 * The host agent.
 *
 * Here rather than in `access-timeline.ts`, which is the module that builds
 * the timeline and therefore reaches the session file through `node:fs`. Both
 * the live merge and the editor's access labels compare against this identity
 * in the browser, and importing it from the timeline pulls that whole server
 * graph — pi's own entry point included — into the client bundle. This module
 * imports nothing, so it is the one place both sides can share a value.
 */
export const MAIN_AGENT: AccessAgent = { id: "main", label: "Main" };

export type AccessKind = "read" | "write";

export type AccessTool = "read" | "edit" | "write" | "code_resolve" | "bash";

/**
 * How much to trust the path.
 *
 * `bash` accesses are parsed out of a shell command and can be wrong; every
 * other source took the path from a typed argument. The scrubber shows the
 * difference rather than hiding it, because a parser that silently opens the
 * wrong file is worse than one that admits it guessed.
 */
export type AccessConfidence = "exact" | "inferred";

/**
 * One file the agent touched, before it has been placed in a session.
 *
 * Produced by the per-tool extractors, which know about arguments and results
 * but not about projects or the filesystem.
 */
export interface RawAccess {
  /** Exactly as the tool named it: absolute, or relative to the agent cwd. */
  rawPath: string;
  kind: AccessKind;
  /** Empty means the whole file. */
  ranges: LineRange[];
  symbol?: AccessSymbol;
  tool: AccessTool;
  confidence: AccessConfidence;
  /**
   * For a `bash` access, the shell command that produced it — "sed", "grep".
   *
   * `tool: "bash"` on its own is the least informative attribution the
   * timeline carries: it says the agent used a shell, which is true of three
   * quarters of all tool calls. The parser already knows which matcher fired,
   * so the verb is recorded rather than discarded, and the UI can say "bash ·
   * sed" where it could previously only say "bash".
   *
   * Undefined for every typed tool, where `tool` is the whole answer.
   */
  via?: string;
}

/** A `RawAccess` resolved against a workspace, ready for the UI. */
export interface FileAccess {
  /** Tool call id, suffixed when one call produced several accesses. */
  id: string;
  /**
   * The bare tool call id, never suffixed.
   *
   * `id` above gets a `#index` suffix when one call touched several files, so
   * it cannot be used to find this access's parent `ToolCallStep` — the live
   * merge in `access-live-merge.ts` needs the unsuffixed id to match a
   * `FileAccess` back to the `SessionToolCall` it came from.
   */
  callId: string;
  /** Workspace-relative project path, or null when outside every linked one. */
  project: string | null;
  /** Project-relative when `project` is set; workspace-relative otherwise. */
  path: string;
  kind: AccessKind;
  ranges: LineRange[];
  symbol?: AccessSymbol;
  agent: AccessAgent;
  /** The `TurnNode.id` this descends from — the user message entry id. */
  turnId: string;
  at: string;
  tool: AccessTool;
  confidence: AccessConfidence;
  /** The shell verb behind a `bash` access — see `RawAccess.via`. */
  via?: string;
  /** The path did not exist when the timeline was built. Not navigable. */
  missing: boolean;
}

/**
 * One tool call, carrying every file it touched.
 *
 * The scrubber's unit of navigation: a call that touched nothing still gets
 * one of these, with `accesses: []` — `ask_user`, `workflow_control`, an mcp
 * call, a `bash` the shell parser did not recognise. Without it, the only
 * record of a session's non-file work would be gone by the time the browser
 * sees it, the same gap `FileAccess` itself closes for `details`.
 */
export interface ToolCallStep {
  /** Tool call id — matches `SessionToolCall.id` for the live merge. */
  id: string;
  /** The real tool name — "bash", "read", "code_resolve", "ask_user", … */
  name: string;
  agent: AccessAgent;
  /** The `TurnNode.id` this descends from. */
  turnId: string;
  at: string;
  /** First scalar argument, e.g. `bash: npm test` — see `summarizeArguments`. */
  summary?: string;
  isError: boolean;
  /** Empty when the call touched no file. */
  accesses: FileAccess[];
}

/**
 * Turn id for accesses reported live, before anything is persisted.
 *
 * A live event arrives while the turn is still running, so the entry id the
 * history endpoint will eventually attribute it to does not exist yet. The
 * scrubber scopes on this until the refetch at turn end replaces the live
 * records with real ones.
 */
export const LIVE_TURN_ID = "\u2039live\u203a";

/** One turn, in conversation order. */
export interface TimelineTurn {
  /** `TurnNode.id` — the user message entry id. */
  id: string;
  at: string;
}

/** What the history endpoint answers with. */
export interface FileAccessTimeline {
  calls: ToolCallStep[];
  /** Every agent that appears, in first-seen order, for the filter. */
  agents: AccessAgent[];
  /** Turns in conversation order, so the client can scope without the graph. */
  turns: TimelineTurn[];
}
