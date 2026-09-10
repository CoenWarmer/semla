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
}

/** A `RawAccess` resolved against a workspace, ready for the UI. */
export interface FileAccess {
  /** Tool call id, suffixed when one call produced several accesses. */
  id: string;
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
  /** The path did not exist when the timeline was built. Not navigable. */
  missing: boolean;
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
  accesses: FileAccess[];
  /** Every agent that appears, in first-seen order, for the filter. */
  agents: AccessAgent[];
  /** Turns in conversation order, so the client can scope without the graph. */
  turns: TimelineTurn[];
}
