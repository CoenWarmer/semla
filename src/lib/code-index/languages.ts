/**
 * Extension -> language, and whether that language has an AST chunker.
 *
 * The fifteen grammars are the ones `@mrclrchtr/supi-tree-sitter` 6.0.0 ships
 * as wasm under `resources/grammars`. They are listed here rather than probed
 * at runtime so that a package upgrade which drops one is a failing test rather
 * than a silent downgrade of every file in that language to line chunking.
 *
 * Anything mapped to `null` is still indexed, by line windows. Markdown is the
 * case that matters: a repository's design docs answer "why is it like this"
 * better than its code does, and this repository keeps its reasoning in
 * `docs/plans/` and in docblocks.
 */

export const GRAMMAR_LANGUAGES = [
  "bash",
  "c",
  "cpp",
  "go",
  "html",
  "java",
  "javascript",
  "kotlin",
  "python",
  "r",
  "ruby",
  "rust",
  "sql",
  "tsx",
  "typescript",
] as const;

export type GrammarLanguage = (typeof GRAMMAR_LANGUAGES)[number];

/** Languages indexed with line windows because no grammar exists for them. */
export type FallbackLanguage = "markdown" | "json" | "yaml" | "text";

export type IndexLanguage = GrammarLanguage | FallbackLanguage;

const BY_EXTENSION: Readonly<Record<string, IndexLanguage>> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  py: "python",
  pyi: "python",
  go: "go",
  rs: "rust",
  rb: "ruby",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  sql: "sql",
  r: "r",
  html: "html",
  md: "markdown",
  mdx: "markdown",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
};

const GRAMMARS = new Set<string>(GRAMMAR_LANGUAGES);

/** The language for a path, or null when it is not worth indexing. */
export function languageOf(path: string): IndexLanguage | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  return BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? null;
}

export function hasGrammar(language: IndexLanguage): language is GrammarLanguage {
  return GRAMMARS.has(language);
}

/**
 * Test files, by the conventions this repository and its neighbours use.
 *
 * Kept as a path rule rather than a content heuristic: a file's name is stable,
 * cheap, and the same answer every run, where "does it import vitest" changes
 * with an edit and would reclassify chunks mid-session.
 */
export function isTestPath(path: string): boolean {
  return (
    /\.(test|spec)\.[a-z]+$/i.test(path) ||
    /(^|\/)(__tests__|__mocks__|tests?)\//i.test(path) ||
    /(^|\/)conformance\.[a-z]+$/i.test(path)
  );
}
