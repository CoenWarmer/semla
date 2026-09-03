/**
 * Which function a line is inside.
 *
 * The review editor runs Monaco with no language service — deliberately, see
 * monaco-setup.ts — so the browser knows the text of a file and nothing about
 * its meaning. A right-click at line 40 therefore cannot name the function it
 * happened in, and asking the operator to type the name would defeat the point
 * of a context menu.
 *
 * This answers it with the same machinery the code map uses, so the two agree
 * by construction: the label returned here is exactly what `buildCodeMap`
 * accepts as its `symbol`, including the `Container.method` form.
 *
 * Innermost wins. `isCallableDeclaration` counts a class as callable, so a line
 * inside a method is inside both the method and the class; the narrower range
 * is the one the reader meant.
 */

import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

import type { Node } from "typescript/unstable/ast";

import { callableDeclarations } from "./call-graph.ts";
import { getProjectProgram } from "./program.ts";

export type EnclosingSymbolOptions = {
  /** File to look in. Absolute, or relative to `cwd`. */
  file: string;
  /** One-based line, as the editor counts them. */
  line: number;
  cwd?: string;
};

export type EnclosingSymbol = {
  /** What `buildCodeMap` takes: `handlePrompt`, or `Pipeline.run`. */
  symbol: string;
  /** Bare name, for prose that reads better without the container. */
  name: string;
  /** The container, when the symbol is a method. */
  container: string | null;
  /** One-based, inclusive: the whole declaration, not just its signature. */
  startLine: number;
  endLine: number;
};

/** One-based line range of a declaration, inclusive. */
function lineRange(node: Node): { end: number; start: number } {
  const source = node.getSourceFile();
  return {
    end: source.getLineAndCharacterOfPosition(node.end).line + 1,
    start: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
  };
}

/**
 * The narrowest callable declaration containing `line`, or null.
 *
 * Null is a real answer rather than an error: a line in an import block, a
 * top-level constant or a comment is inside no function, and the menu should
 * say so rather than guess at the nearest one.
 */
export function enclosingSymbol(
  options: EnclosingSymbolOptions,
): EnclosingSymbol | null {
  const cwd = options.cwd ?? process.cwd();
  const filePath = isAbsolute(options.file)
    ? options.file
    : resolve(cwd, options.file);

  // The same check buildCodeMap makes first, for the same reason: the failure
  // that actually happens is a path missing its repository prefix, and
  // reporting it as "no tsconfig" sends the reader after the wrong problem.
  if (!existsSync(filePath)) {
    throw new Error(
      `${options.file} does not exist. Paths are resolved relative to ${cwd}.`,
    );
  }

  const { program, projectRoot } = getProjectProgram(dirname(filePath));
  const source = program.getSourceFile(filePath);

  if (!source) {
    throw new Error(
      `${filePath} is not part of the TypeScript project rooted at ${projectRoot}.`,
    );
  }

  let best: { entry: EnclosingSymbol; width: number } | null = null;

  for (const declaration of callableDeclarations(source)) {
    const { end, start } = lineRange(declaration.node);
    if (options.line < start || options.line > end) continue;

    const width = end - start;
    if (best && width >= best.width) continue;

    const dot = declaration.label.lastIndexOf(".");
    best = {
      entry: {
        container: dot === -1 ? null : declaration.label.slice(0, dot),
        endLine: end,
        name: dot === -1 ? declaration.label : declaration.label.slice(dot + 1),
        startLine: start,
        symbol: declaration.label,
      },
      width,
    };
  }

  return best?.entry ?? null;
}
