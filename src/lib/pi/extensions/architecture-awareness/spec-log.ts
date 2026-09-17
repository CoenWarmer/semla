/**
 * Item 2: SPEC.md — verbatim, append-only user-turn log.
 *
 * Lives in the session's own directory (`<PI_SESSION_DIR>/<sessionId>.spec.md`),
 * not the target repo — unlike PLACEMENT.md, which describes the repo and is
 * authored once, SPEC.md is this conversation's own record and has no reason
 * to be shared across sessions or committed to the target repo's tree.
 *
 * No classification, no model call, no filtering: every user turn is
 * persisted verbatim with its turn index and timestamp, in the order it
 * happened. Chronological order is the only conflict-resolution rule — later
 * entries supersede earlier ones by position, and nothing here decides that
 * for the model; the review pass (item 5) is where genuine ambiguity gets
 * surfaced to the operator.
 *
 * A `@spec` prefix marks a turn as load-bearing. It changes nothing about how
 * the turn is stored — still one line, same order — only how it is rendered
 * on injection: `@spec` turns are hoisted to the front of the block. See
 * `renderSpecLog`.
 *
 * Distillation (batch summarisation once the log passes ~40 turns) is
 * explicitly not built here. See `shouldConsiderDistillation` — it exists
 * only as a signal for later work, and is never called from this module.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const SPEC_LOG_PREFIX = "@spec";

export interface SpecTurn {
  turnIndex: number;
  /** ISO timestamp. */
  timestamp: string;
  /** Verbatim user text, `@spec` prefix stripped if present. */
  text: string;
  /** Whether this turn carried the `@spec` marker. */
  loadBearing: boolean;
  /**
   * The durable prompt-turn id this turn was appended under
   * (src/lib/pi/session/turn-id.ts), or null for a line written before turn
   * ids existed. Bookkeeping only — never injected into the prompt by
   * `renderSpecLog` — but it is what lets a human reading SPEC.md match a
   * line back to the spec artifact it produced, and what
   * spec-persistence.ts stamps a captured spec artifact with.
   */
  turnId: string | null;
}

export function specLogPath(sessionDir: string, sessionId: string): string {
  return join(sessionDir, `${sessionId}.spec.md`);
}

/**
 * Whether a user turn's raw text carries the `@spec` marker, and the text
 * with the marker stripped. The marker must lead the message (after
 * whitespace) — `@spec` is a message-level annotation, not a token to be
 * mentioned mid-sentence.
 */
export function parseSpecMarker(rawText: string): { loadBearing: boolean; text: string } {
  const trimmed = rawText.trimStart();
  if (trimmed.toLowerCase().startsWith(SPEC_LOG_PREFIX.toLowerCase())) {
    const rest = trimmed.slice(SPEC_LOG_PREFIX.length);
    return { loadBearing: true, text: rest.trimStart() };
  }
  return { loadBearing: false, text: rawText };
}

/**
 * One append-only line per user turn. `\u2014` (em dash) separates the
 * metadata header from the text so a line is greppable and diffable without
 * parsing markdown structure. `@spec` turns get a marker in the header, not
 * just in the text, so `readSpecLog` doesn't have to re-derive it from text
 * that already had the prefix stripped.
 */
function formatSpecLine(turn: SpecTurn): string {
  const marker = turn.loadBearing ? " [@spec]" : "";
  const idTag = turn.turnId ? ` [id:${turn.turnId}]` : "";
  // Turn text is stored on one line: embedded newlines are escaped so the
  // log's one-line-per-turn invariant holds and a later read can split on "\n"
  // without ambiguity.
  const escaped = turn.text.replace(/\r?\n/g, "\\n");
  return `[turn ${turn.turnIndex}] [${turn.timestamp}]${marker}${idTag} \u2014 ${escaped}`;
}

/**
 * Append one user turn to SPEC.md. Creates the file and its directory if
 * absent. Never truncates or rewrites existing lines — append-only per the
 * plan, so a later constraint can supersede an earlier one only by position,
 * never by overwriting it.
 */
export function appendSpecTurn(
  sessionDir: string,
  sessionId: string,
  turn: SpecTurn,
): void {
  const path = specLogPath(sessionDir, sessionId);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(path, `${formatSpecLine(turn)}\n`, "utf-8");
}

/** Read every turn from a session's SPEC.md, in file order. Empty when absent. */
export function readSpecLog(sessionDir: string, sessionId: string): SpecTurn[] {
  const path = specLogPath(sessionDir, sessionId);
  if (!existsSync(path)) return [];

  const contents = readFileSync(path, "utf-8");
  const turns: SpecTurn[] = [];

  // Backward compatible: `[id:<turnId>]` is optional, so a line written
  // before turn ids existed still parses, with `turnId: null`.
  const lineRe =
    /^\[turn (\d+)\] \[([^\]]+)\](?: \[@spec\])?(?: \[id:([^\]]+)\])? \u2014 (.*)$/;
  for (const line of contents.split("\n")) {
    if (!line.trim()) continue;
    const match = lineRe.exec(line);
    if (!match) continue;
    const [, turnIndexStr, timestamp, turnId, escaped] = match;
    turns.push({
      loadBearing: line.includes("[@spec]"),
      text: escaped.replace(/\\n/g, "\n"),
      timestamp,
      turnId: turnId ?? null,
      turnIndex: Number(turnIndexStr),
    });
  }

  return turns;
}

/**
 * Render the log for injection: `@spec` turns first (in their own
 * chronological order), then every other turn chronologically. This is the
 * one place order is imposed for presentation — the file itself stays purely
 * append-only/chronological.
 */
export function renderSpecLog(turns: readonly SpecTurn[]): string {
  if (turns.length === 0) return "";

  const loadBearing = turns.filter((t) => t.loadBearing);
  const rest = turns.filter((t) => !t.loadBearing);

  const lines: string[] = [];
  if (loadBearing.length > 0) {
    lines.push("## Load-bearing (@spec)", "");
    for (const turn of loadBearing) lines.push(`- ${turn.text}`);
    lines.push("");
  }
  if (rest.length > 0) {
    lines.push("## Chronological (later supersedes earlier)", "");
    for (const turn of rest) lines.push(`- [turn ${turn.turnIndex}] ${turn.text}`);
  }

  return lines.join("\n").trim();
}

/**
 * Signal only — deliberately never called. The plan (item 2) reframes
 * distillation as a later fallback gated on log size, run in batch over the
 * whole log, never per-turn. This constant documents the threshold so a
 * later implementer finds the number here rather than picking a new one.
 */
export const DISTILLATION_TURN_THRESHOLD = 40;

/** Whether a log has grown past the point distillation would be worth building. Informational only. */
export function shouldConsiderDistillation(turns: readonly SpecTurn[]): boolean {
  return turns.length > DISTILLATION_TURN_THRESHOLD;
}
