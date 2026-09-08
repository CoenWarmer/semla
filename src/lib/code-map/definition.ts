/**
 * Where the symbol under a cursor is declared.
 *
 * The review editor runs Monaco without a language service — deliberately, see
 * monaco-setup.ts — so the browser has the text of a file and none of its
 * meaning. Cmd+click on `<ReviewFileTree />` or on `resolveReviewTarget(...)`
 * is a question only the type checker can answer, and this is where it is
 * asked.
 *
 * It is the position-based sibling of `resolveJsxComponent`, which answers the
 * same question from a *name* because its caller (the element picker) only ever
 * has one. A cursor is more precise than a name, so this needs no candidate
 * search: `getTouchingPropertyName` picks the token out of the AST and the
 * checker resolves exactly that occurrence.
 *
 * **Aliases are followed, and that is the whole game in this repository.**
 * `getSymbolAtLocation` on an imported identifier resolves to the *import
 * binding* — the specifier in the importing file — not to the thing imported.
 * Following the alias is what turns "line 23 of this file, where the import
 * is" into the declaration the reader wanted.
 *
 * **Unlike the code map, this does not stop at the project boundary.**
 * `isExternalFile` exists so a call graph is not buried in a dependency's
 * internals, but reading the declaration of a type from a `.d.ts` is a
 * legitimate destination for a click — often the most useful one. The caller
 * decides what it can serve; this reports what it found and says whether it is
 * external.
 */

import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

import type { Node } from "typescript/unstable/ast";
import { getTouchingPropertyName } from "typescript/unstable/ast";
import { isIdentifier, isPrivateIdentifier } from "typescript/unstable/ast/is";
import { SymbolFlags } from "typescript/unstable/sync";

import {
  displayPath,
  isExternalFile,
  lineOf,
  pickDeclaration,
} from "./declarations.ts";
import { getProjectProgram } from "./program.ts";

export type DefinitionLocation = {
  /** Shortest addressable path, per `displayPath`'s roots. For display. */
  file: string;
  /**
   * The declaration's absolute path.
   *
   * Carried alongside `file` because a caller that has to re-root the answer —
   * against a session's workspace rather than against a tsconfig — cannot do
   * that from a relative path without knowing which root it was shortened
   * against, and guessing at that is how a path silently gains or loses a
   * repository prefix.
   */
  absolute: string;
  /** One-based, as an editor counts. */
  line: number;
  /** The symbol's own name, for a message when the file cannot be opened. */
  name: string;
  /**
   * A `.d.ts` or something under node_modules. Not a refusal — a caller may
   * still open it, but not for editing.
   */
  external: boolean;
};

export type DefinitionAtOptions = {
  /** File the cursor is in. Absolute, or relative to `cwd`. */
  file: string;
  /** One-based line, as the editor counts them. */
  line: number;
  /** One-based column, as the editor counts them. */
  character: number;
  cwd?: string;
};

/**
 * Only tokens that can name something are worth asking the checker about.
 *
 * `getTouchingPropertyName` returns whatever token is under the position,
 * including punctuation and keywords. Asking the checker about `{` costs a
 * round-trip to answer nothing, and this runs on every hover once the gesture
 * is enabled — Monaco calls the provider to decide whether to draw the
 * underline, not only on the click.
 */
function isNameToken(node: Node): boolean {
  return isIdentifier(node) || isPrivateIdentifier(node);
}

/**
 * The declaration of the symbol at a position, or null.
 *
 * Null is an ordinary answer with several ordinary causes: the position is on
 * punctuation or a keyword, the identifier is itself the declaration, the
 * symbol is a built-in with no declaration node, or the file is not in a
 * TypeScript project. A caller should say nothing happened rather than treat
 * any of these as a fault.
 *
 * Throws only when the *request* cannot be honoured — a path that does not
 * exist, or a file outside the project the checker was built for. Those are
 * worth reporting, because they usually mean a path lost its repository
 * prefix on the way here.
 */
export function definitionAt(
  options: DefinitionAtOptions,
): DefinitionLocation | null {
  const cwd = options.cwd ?? process.cwd();
  const filePath = isAbsolute(options.file)
    ? options.file
    : resolve(cwd, options.file);

  // The same check enclosingSymbol and buildCodeMap make first, for the same
  // reason: the failure that actually happens is a path missing its repository
  // prefix, and reporting that as "no tsconfig" sends the reader after the
  // wrong problem.
  if (!existsSync(filePath)) {
    throw new Error(
      `${options.file} does not exist. Paths are resolved relative to ${cwd}.`,
    );
  }

  const { checker, program, project, projectRoot } = getProjectProgram(
    dirname(filePath),
  );
  const source = program.getSourceFile(filePath);

  if (!source) {
    throw new Error(
      `${filePath} is not part of the TypeScript project rooted at ${projectRoot}.`,
    );
  }

  // Monaco counts lines and columns from one; the compiler counts from zero.
  const position = source.getPositionOfLineAndCharacter(
    options.line - 1,
    options.character - 1,
  );

  const token = getTouchingPropertyName(source, position);
  if (!isNameToken(token)) return null;

  const name = token.getText();

  let symbol = checker.getSymbolAtLocation(token);
  if (!symbol) return null;

  // `import { ReviewFileTree } from "./review-file-tree"` resolves to the
  // import binding, whose declaration is the specifier in *this* file. Almost
  // every cross-file click in this repository arrives here.
  if (symbol.flags & SymbolFlags.Alias) {
    symbol = checker.getAliasedSymbol(symbol);
  }

  const declaration = pickDeclaration(symbol.declarations, project);
  if (!declaration) return null;

  const declarationFile = declaration.getSourceFile().fileName;
  const declaredLine = lineOf(declaration);

  // The identifier *is* the declaration — clicking a function's own name, or a
  // parameter where it is introduced. Jumping to where the cursor already is
  // reads as the editor having ignored the click, so report nothing and let
  // the caller leave the cursor alone.
  if (declarationFile === filePath && declaredLine === options.line) {
    return null;
  }

  return {
    absolute: declarationFile,
    external: isExternalFile(declarationFile),
    file: displayPath(declarationFile, [cwd, projectRoot]),
    line: declaredLine,
    name,
  };
}
