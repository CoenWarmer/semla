/**
 * Pure parsing for turning an inline-code span's text into a file target the
 * Review panel can open — no React, no project resolution, so the regex and
 * its edge cases (URLs, version strings, bare numbers) are unit-testable
 * without mounting anything.
 *
 * Deliberately conservative: false positives here mean a click opens the
 * wrong thing or nothing, silently. Everything a token could be other than a
 * source file reference — a URL, a semver string, a bare word — is rejected
 * rather than guessed at.
 */

/**
 * Extensions a chat message plausibly names as a project file. Not
 * exhaustive; the cost of missing one is a token that stays plain text, the
 * cost of a false positive is a wrong-looking clickable link, so this errs
 * toward the former.
 */
const CODE_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts",
  "json", "jsonc", "md", "mdx", "css", "scss",
  "html", "py", "rb", "go", "rs", "java", "kt", "swift",
  "c", "h", "cpp", "hpp", "sh", "bash", "yml", "yaml",
  "toml", "sql", "prisma", "proto", "graphql", "vue", "svelte",
]);

/** Anything that is not a plausible path character. */
const INVALID_PATH_CHAR_REGEX = /[\\<>|*?"\s]/;

/**
 * Splits a trailing `:line` or `:line:column` off `text`, if present.
 *
 * Not a single regex: a greedy `(.+):(\d+)(?::\d+)?$` backtracks onto the
 * *last* colon-digit group first, so `src/foo.ts:42:7` matches with
 * `rawPath="src/foo.ts:42"` and the line dropped, not the other way around.
 * Splitting from the right by hand — at most two colon-number segments —
 * side-steps the backtracking order entirely.
 */
function splitTrailingLine(text: string): { path: string; line: number | null } {
  const segments = text.split(":");
  const trailingDigits = (segment: string | undefined): number | null =>
    segment !== undefined && /^\d+$/.test(segment) ? Number.parseInt(segment, 10) : null;

  if (segments.length >= 3 && trailingDigits(segments.at(-1)) !== null && trailingDigits(segments.at(-2)) !== null) {
    return { line: trailingDigits(segments.at(-2)), path: segments.slice(0, -2).join(":") };
  }
  if (segments.length >= 2 && trailingDigits(segments.at(-1)) !== null) {
    return { line: trailingDigits(segments.at(-1)), path: segments.slice(0, -1).join(":") };
  }
  return { line: null, path: text };
}

export type ParsedFileToken = {
  /** Exactly as written, with any trailing `:line[:column]` stripped. */
  rawPath: string;
  /** 1-based, or null when the token named no line. */
  line: number | null;
};

function hasCodeExtension(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot === -1 || dot === path.length - 1) return false;
  return CODE_EXTENSIONS.has(path.slice(dot + 1).toLowerCase());
}

/**
 * Whether `text` looks like a project-relative source file reference, e.g.
 * `src/foo.ts` or `src/foo.ts:42`.
 *
 * Returns null for anything else: URLs (`://`), absolute paths, paths that
 * climb out with `..`, bare numbers or words, version strings (`1.2.3`), and
 * anything without a recognized code extension — a directory name or a bare
 * word is not a file to open.
 */
export function parseFilePathToken(text: string): ParsedFileToken | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (INVALID_PATH_CHAR_REGEX.test(trimmed)) return null;
  if (trimmed.includes("://")) return null;
  if (trimmed.startsWith("/") || trimmed.startsWith(".")) return null;

  const { line, path: rawPath } = splitTrailingLine(trimmed);

  if (!rawPath || rawPath.includes("://")) return null;
  // No repeated slashes, no trailing slash, no climbing out.
  if (/\/\/|\/$/.test(rawPath)) return null;
  if (rawPath.split("/").some((segment) => segment === "..")) return null;
  if (!hasCodeExtension(rawPath)) return null;

  return { line: line !== null && line > 0 ? line : null, rawPath };
}

/**
 * Which attached project a parsed token belongs to, and the path within it.
 *
 * A session may have more than one project attached (see
 * `session-project-links.ts`); a bare relative path is ambiguous between
 * them unless there is only one attached, or the token's own leading
 * segment names one explicitly (`catalog-info/src/foo.ts`). Any other case
 * returns null rather than guessing — the caller's only chance to refuse
 * before `elementTarget.request()` opens the wrong repository's file under
 * a right-looking name.
 */
export function resolveFileToken(
  token: ParsedFileToken,
  projectSlugs: readonly string[],
): { project: string; path: string; line: number | null } | null {
  if (projectSlugs.length === 0) return null;

  if (projectSlugs.length === 1) {
    const [project] = projectSlugs;
    return { line: token.line, path: token.rawPath, project };
  }

  const [first, ...rest] = token.rawPath.split("/");
  if (first && rest.length > 0 && projectSlugs.includes(first)) {
    return { line: token.line, path: rest.join("/"), project: first };
  }

  return null;
}
