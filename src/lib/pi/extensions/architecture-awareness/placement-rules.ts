/**
 * Parsing and matching for a target repo's `PLACEMENT.md`.
 *
 * `PLACEMENT.md` lives in the repo the agent is *operating on* (`ctx.cwd`),
 * not in Semla. It is a directive lookup table, one rule per line:
 *
 *   new REST route -> server/routes/
 *   shared utility -> src/lib/
 *
 * Deliberately dumb parsing: no markdown structure is required beyond one
 * rule per line containing `->`. A file that doesn't follow that format
 * produces zero rules rather than throwing, so a malformed file degrades to
 * "no placement rules" instead of failing every turn — the caller decides
 * whether that silence is loud enough to matter (see `placement-prompt.ts`,
 * which caps token count and fails loudly on that, but says nothing about
   * malformed content).
 *
 * The match is substring-on-target, case-insensitive: a `target_module` of
 * `server/routes/users.ts` matches a rule whose destination is
 * `server/routes/`. This is deliberately permissive rather than a path-glob
 * engine — the rule file's authors write directory prefixes, and the agent's
 * `target_module` argument is free text naming a directory or module, not
 * always a path with a trailing slash.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const PLACEMENT_FILE_NAME = "PLACEMENT.md";

export interface PlacementRule {
  /** The situation the rule matches, e.g. "new REST route". Free text. */
  situation: string;
  /** Where that situation's code belongs, e.g. "server/routes/". Free text. */
  destination: string;
  /** The verbatim source line, for quoting back in a rejection message. */
  raw: string;
}

export interface PlacementFile {
  /** Absolute path the file was read from. */
  path: string;
  /** Raw file contents, unparsed — what gets injected into the system prompt. */
  contents: string;
  /** Parsed directive rules, in file order. */
  rules: PlacementRule[];
}

/** Absolute path to PLACEMENT.md inside a target repo's working directory. */
export function placementFilePath(cwd: string): string {
  return join(cwd, PLACEMENT_FILE_NAME);
}

/**
 * Read and parse `PLACEMENT.md` from a target repo's working directory.
 *
 * Returns null when the file is absent — the caller logs at debug level and
 * injects nothing. Never synthesises a substitute: an absent file means the
 * repo has not opted in, not that Semla should guess at its structure.
 */
export function loadPlacementFile(cwd: string): PlacementFile | null {
  const path = placementFilePath(cwd);
  if (!existsSync(path)) return null;

  let stat;
  try {
    stat = statSync(path);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;

  const contents = readFileSync(path, "utf-8");
  return { contents, path, rules: parsePlacementRules(contents) };
}

/**
 * Parse directive lines of the form `<situation> -> <destination>`.
 *
 * Lines with no `->` are ignored (headings, prose, blank lines) rather than
 * treated as a parse error — the format is a lookup table embedded in
 * whatever markdown the repo's authors otherwise want around it.
 */
export function parsePlacementRules(contents: string): PlacementRule[] {
  const rules: PlacementRule[] = [];

  for (const line of contents.split("\n")) {
    const raw = line.trim();
    if (!raw || !raw.includes("->")) continue;

    const arrowIndex = raw.indexOf("->");
    const situation = raw.slice(0, arrowIndex).trim().replace(/^[-*]\s*/, "");
    const destination = raw.slice(arrowIndex + 2).trim();
    if (!situation || !destination) continue;

    rules.push({ destination, raw, situation });
  }

  return rules;
}

/**
 * Whether a proposed `target_module` is consistent with the placement rules,
 * and — when it is not — the specific rule it contradicts.
 *
 * A module is "contradicted" only when some rule's destination looks like a
 * plausible alternative location for the *same kind of change* and the
 * proposed module does not match any rule naming that destination. Absent
 * any rule that mentions this kind of change at all, the module is allowed:
 * PLACEMENT.md is a lookup table for situations its authors thought to name,
 * not an exhaustive allowlist of every directory in the repo.
 *
 * Matching is intentionally shallow (see module docblock) — this is a
 * cheap, explainable check, not a build system.
 */
export interface PlacementCheck {
  allowed: boolean;
  /** The rule the target_module was checked against, when one was found. */
  matchedRule?: PlacementRule;
}

export function checkPlacement(
  targetModule: string,
  rules: readonly PlacementRule[],
): PlacementCheck {
  const normalizedTarget = targetModule.trim().toLowerCase();
  if (!normalizedTarget || rules.length === 0) return { allowed: true };

  for (const rule of rules) {
    const destination = rule.destination.toLowerCase();
    if (normalizedTarget.includes(destination) || destination.includes(normalizedTarget)) {
      return { allowed: true, matchedRule: rule };
    }
  }

  return { allowed: false };
}

/** Rough token estimate — four characters per token, no tokenizer dependency. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export class PlacementFileTooLargeError extends Error {
  constructor(
    public readonly path: string,
    public readonly estimatedTokens: number,
    public readonly maxTokens: number,
  ) {
    super(
      `${path} is approximately ${estimatedTokens} tokens, over the ${maxTokens}-token cap. ` +
        "Shorten it — PLACEMENT.md is injected into every system prompt in full, so it must " +
        "stay small. Truncating it silently would mean rules the file's authors wrote are " +
        "sometimes not there; failing loudly here is deliberate.",
    );
  }
}

/** Default cap. Configurable per session via ArchitectureAwarenessSettings. */
export const DEFAULT_PLACEMENT_MAX_TOKENS = 2000;

/** Throws PlacementFileTooLargeError when the file exceeds the token cap. */
export function assertPlacementFileWithinBudget(
  file: PlacementFile,
  maxTokens: number = DEFAULT_PLACEMENT_MAX_TOKENS,
): void {
  const tokens = estimateTokens(file.contents);
  if (tokens > maxTokens) {
    throw new PlacementFileTooLargeError(file.path, tokens, maxTokens);
  }
}
