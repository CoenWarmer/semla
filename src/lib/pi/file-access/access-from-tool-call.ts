/**
 * Turning one tool call into the files it touched.
 *
 * Reads arguments and `details` from the persisted session entry, which is the
 * richest form this data ever takes. Everything here is pure: no filesystem, no
 * project resolution, no knowledge of which session or agent it belongs to.
 * Those are added by access-paths.ts and access-timeline.ts respectively, so
 * this file can be tested with object literals.
 *
 * `bash` is handled by bash-read-parser.ts and joined in here, because callers
 * should not have to know which tools happen to need a shell parser.
 */

import { parseBashAccesses } from "./bash-read-parser";
import type { LineRange, RawAccess } from "./access-types";

export interface ToolCallRecord {
  id: string;
  name: string;
  /** The `arguments` object from the assistant's `toolCall` content block. */
  arguments: unknown;
  /** The `details` field of the matching `toolResult`, when it had one. */
  details?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringField = (source: unknown, key: string): string | null => {
  if (!isRecord(source)) return null;
  const value = source[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
};

const numberField = (source: unknown, key: string): number | null => {
  if (!isRecord(source)) return null;
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : null;
};

/**
 * The lines a `read` actually asked for.
 *
 * Pi's read takes `offset` (1-based first line) and `limit` (how many). Neither
 * is required, and the three combinations mean different things: no arguments
 * is the whole file, `offset` alone runs to EOF, and `limit` alone starts at
 * line 1. Returning `[]` for the whole-file case rather than `[{1, null}]`
 * keeps "the agent read all of this" distinguishable from "the agent read from
 * the top", which is what the scrubber shows in its label.
 */
function readRanges(args: unknown): LineRange[] {
  const offset = numberField(args, "offset");
  const limit = numberField(args, "limit");
  if (offset === null && limit === null) return [];

  const start = offset ?? 1;
  return [{ end: limit === null ? null : start + limit - 1, start }];
}

/**
 * Symbol targets from a code-intelligence result.
 *
 * `code_resolve` answers with `details.data.targets[]`, each carrying `file`,
 * `displayLine`, `name` and `kind` — the only place in the whole tool surface
 * where a symbol's definition line is handed over directly. Written against the
 * shape rather than the tool name so a sibling tool that grows the same
 * `targets` array is picked up without an edit here; `code_find` currently
 * answers with `evidenceLists` instead and yields nothing, which is correct.
 */
function codeIntelligenceAccesses(details: unknown): RawAccess[] {
  if (!isRecord(details)) return [];
  const data = details.data;
  if (!isRecord(data) || !Array.isArray(data.targets)) return [];

  const accesses: RawAccess[] = [];
  for (const target of data.targets) {
    const file = stringField(target, "file");
    const line = numberField(target, "displayLine");
    if (!file || line === null) continue;

    const name = stringField(target, "name");
    accesses.push({
      confidence: "exact",
      kind: "read",
      ranges: [{ end: line, start: line }],
      rawPath: file,
      tool: "code_resolve",
      ...(name
        ? { symbol: { kind: stringField(target, "kind") ?? "Symbol", line, name } }
        : {}),
    });
  }

  return accesses;
}

/**
 * Every file one tool call touched, in the order the call implies.
 *
 * An unrecognised tool yields nothing. That includes the wiki tools, which
 * write to the vault rather than to a project, and `mcp`, whose `details.matches`
 * are MCP tools rather than files — a shape close enough to a code search to be
 * worth naming as deliberately excluded.
 */
export function accessesFromToolCall(call: ToolCallRecord): RawAccess[] {
  switch (call.name) {
    case "read": {
      const path = stringField(call.arguments, "path");
      if (!path) return [];
      return [
        {
          confidence: "exact",
          kind: "read",
          ranges: readRanges(call.arguments),
          rawPath: path,
          tool: "read",
        },
      ];
    }

    case "edit": {
      const path = stringField(call.arguments, "path");
      if (!path) return [];
      // `firstChangedLine` is pi's own "for editor navigation" hint. One edit
      // result in the sampled corpus carried an empty `details` object, so its
      // absence is expected rather than exceptional: the file still opens, and
      // the editor's hunk-based auto-scroll usually lands correctly anyway.
      const line = numberField(call.details, "firstChangedLine");
      return [
        {
          confidence: "exact",
          kind: "write",
          ranges: line === null ? [] : [{ end: line, start: line }],
          rawPath: path,
          tool: "edit",
        },
      ];
    }

    case "write": {
      const path = stringField(call.arguments, "path");
      if (!path) return [];
      return [
        {
          confidence: "exact",
          kind: "write",
          // A whole-file write has no first change to point at.
          ranges: [],
          rawPath: path,
          tool: "write",
        },
      ];
    }

    case "bash": {
      const command = stringField(call.arguments, "command");
      return command ? parseBashAccesses(command) : [];
    }

    default:
      return call.name.startsWith("code_")
        ? codeIntelligenceAccesses(call.details)
        : [];
  }
}
