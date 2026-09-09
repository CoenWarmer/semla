/**
 * tree-sitter parsing for the code index.
 *
 * Drives `web-tree-sitter` against the grammars `@mrclrchtr/supi-tree-sitter`
 * vendors, rather than calling that package's own API. See
 * TREE_SITTER_GRAMMAR_DIR in runtime-config.ts for why: the package's API
 * resolves grammars and spawns a worker from `import.meta.url`, which bundling
 * rewrites, and it publishes no compiled build to import instead. The chunker
 * needs a syntax tree and nothing else the package offers.
 *
 * Parsers and languages are cached per process. Loading a grammar is reading
 * and instantiating a wasm module — tens of milliseconds — and an index run
 * parses hundreds of files in one language.
 */

import { join } from "node:path";

import { TREE_SITTER_GRAMMAR_DIR, TREE_SITTER_PACKAGE_DIR } from "@/lib/pi/runtime-config";

import type { GrammarLanguage } from "./languages";

/** Minimal shape of a tree-sitter node. Structural, so no types are imported. */
export interface SyntaxNode {
  type: string;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  text: string;
  namedChildren: SyntaxNode[];
  children: SyntaxNode[];
  childForFieldName(field: string): SyntaxNode | null;
}

export interface SyntaxTree {
  rootNode: SyntaxNode;
}

interface ParserLike {
  setLanguage(language: unknown): void;
  parse(source: string): SyntaxTree | null;
}

/** Grammar filenames are not uniformly derivable from the language name. */
const GRAMMAR_FILE: Readonly<Record<GrammarLanguage, string>> = {
  bash: "bash/tree-sitter-bash.wasm",
  c: "c/tree-sitter-c.wasm",
  cpp: "cpp/tree-sitter-cpp.wasm",
  go: "go/tree-sitter-go.wasm",
  html: "html/tree-sitter-html.wasm",
  java: "java/tree-sitter-java.wasm",
  javascript: "javascript/tree-sitter-javascript.wasm",
  kotlin: "kotlin/tree-sitter-kotlin.wasm",
  python: "python/tree-sitter-python.wasm",
  r: "r/tree-sitter-r.wasm",
  ruby: "ruby/tree-sitter-ruby.wasm",
  rust: "rust/tree-sitter-rust.wasm",
  sql: "sql/tree-sitter-sql.wasm",
  tsx: "tsx/tree-sitter-tsx.wasm",
  typescript: "typescript/tree-sitter-typescript.wasm",
};

const WEB_TREE_SITTER_DIR = join(
  TREE_SITTER_PACKAGE_DIR,
  "node_modules/web-tree-sitter",
);

let runtime: Promise<{ Parser: ParserConstructor; Language: LanguageLoader }> | null = null;
const languages = new Map<GrammarLanguage, Promise<unknown>>();
const parsers = new Map<GrammarLanguage, ParserLike>();

interface ParserConstructor {
  new (): ParserLike;
  init(options: { locateFile: () => string }): Promise<void>;
}

interface LanguageLoader {
  load(path: string): Promise<unknown>;
}

async function loadRuntime() {
  if (runtime === null) {
    runtime = (async () => {
      // Resolved at runtime from a computed path so the bundler does not try to
      // trace the wasm alongside it; the index only ever runs server-side.
      const loaded = (await import(
        /* webpackIgnore: true */ /* turbopackIgnore: true */
        join(WEB_TREE_SITTER_DIR, "web-tree-sitter.js")
      )) as { Parser: ParserConstructor; Language: LanguageLoader };

      await loaded.Parser.init({
        locateFile: () => join(WEB_TREE_SITTER_DIR, "web-tree-sitter.wasm"),
      });
      return loaded;
    })();
  }
  return runtime;
}

/**
 * A parser for `language`, or null when the grammar cannot be loaded.
 *
 * Null rather than throwing: a missing grammar downgrades that language to line
 * chunking, which is a worse index, not a broken one. The caller records the
 * strategy actually used, so the downgrade is visible in the result rather than
 * inferred from disappointing hits.
 */
export async function getParser(
  language: GrammarLanguage,
): Promise<ParserLike | null> {
  const cached = parsers.get(language);
  if (cached !== undefined) return cached;

  try {
    const { Parser, Language } = await loadRuntime();

    let languagePromise = languages.get(language);
    if (languagePromise === undefined) {
      languagePromise = Language.load(join(TREE_SITTER_GRAMMAR_DIR, GRAMMAR_FILE[language]));
      languages.set(language, languagePromise);
    }

    const parser = new Parser();
    parser.setLanguage(await languagePromise);
    parsers.set(language, parser);
    return parser;
  } catch {
    // Cached as absent would need a second map; a failed grammar is rare and
    // retrying it costs one failed file read.
    return null;
  }
}

/** Parse, or null when no grammar is available or the source cannot be parsed. */
export async function parseSource(
  language: GrammarLanguage,
  source: string,
): Promise<SyntaxTree | null> {
  const parser = await getParser(language);
  if (parser === null) return null;
  try {
    return parser.parse(source);
  } catch {
    return null;
  }
}

/** Test seam: drop cached parsers so a test can exercise the cold path. */
export function resetParserCache(): void {
  runtime = null;
  languages.clear();
  parsers.clear();
}
