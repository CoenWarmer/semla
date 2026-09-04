/**
 * Where a JSX component name is actually declared.
 *
 * Exists for exactly one caller: the element picker's fallback when a fiber's
 * `_debugStack` cannot name a real call site. React's dev runtime only
 * captures a real stack for the first ~10,000 elements created within a
 * second (`ReactSharedInternals.recentlyCreatedOwnerStacks`); everything
 * created after that in the same burst gets a shared placeholder pointing at
 * React's own internal `UnknownOwner`, permanently, because the capture only
 * happens once and a mounted element does not get a second chance at it. A
 * client-rendered app's first paint routinely creates more than that in one
 * go, so the *_debugOwner_* walk that survives it lands on the nearest
 * ancestor whose element predates the throttle — in practice the page's
 * Server Component boundary, since RSC elements are deserialized from Flight
 * data through a different code path the throttle never touches.
 *
 * That boundary still names the *component*, though — `<ClientSessionComponent
 * sessionId={id} .../>` is right there in the page's JSX — just not the line
 * inside it the operator actually clicked. So rather than resolve a stack
 * frame, this resolves a *name*: it finds the matching JSX tag in the page's
 * own source, asks the type checker what it refers to, and follows the
 * checker's answer to the real declaration. That is exact rather than a
 * guess — `getSymbolAtLocation` on the tag name is the same resolution the
 * checker performs to type-check the element, not a text search — but it can
 * only ever answer with the component itself, never the line inside it.
 */

import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

import type { Identifier, Node, SourceFile } from "typescript/unstable/ast";
import {
  isIdentifier,
  isJsxOpeningElement,
  isJsxSelfClosingElement,
  isPropertyAccessExpression,
} from "typescript/unstable/ast/is";

import { SymbolFlags } from "typescript/unstable/sync";

import { displayPath, lineOf, pickDeclaration } from "./declarations.ts";
import { getProjectProgram } from "./program.ts";

export type JsxComponentLocation = {
  file: string;
  line: number;
};

/** The tag name identifier of a JSX element, ignoring `<div>`-style tags. */
function tagNameIdentifier(node: Node): Identifier | null {
  if (!isJsxOpeningElement(node) && !isJsxSelfClosingElement(node)) {
    return null;
  }

  const tagName = node.tagName;

  // `<foo.Bar />` — namespaced/property-access tag names. The rightmost
  // identifier is the one a component export resolves through; `foo` is
  // typically a namespace import and resolving it would name the module,
  // not the component.
  if (isPropertyAccessExpression(tagName)) {
    return isIdentifier(tagName.name) ? tagName.name : null;
  }

  return isIdentifier(tagName) ? tagName : null;
}

/**
 * Every JSX tag in `source` whose name matches `componentName`, in document
 * order.
 *
 * A page can name the same component more than once — conditionally, or in a
 * list — so this returns every candidate rather than the first, and the
 * caller decides how many are worth resolving.
 */
function findJsxTags(source: SourceFile, componentName: string): Identifier[] {
  const matches: Identifier[] = [];

  const visit = (node: Node) => {
    const tagName = tagNameIdentifier(node);
    if (tagName && tagName.text === componentName) matches.push(tagName);
    node.forEachChild(visit);
  };

  visit(source);
  return matches;
}

/**
 * Resolve a JSX component name to where it is declared, by finding its use
 * in `file` and asking the checker what that use refers to.
 *
 * `file` is the boundary the caller already resolved by other means — see
 * the module doc — and is expected to contain at least one JSX usage of
 * `componentName`. Returns null rather than throwing for every way that can
 * fail to hold: the file is not in a TypeScript project, the name is not
 * used as a JSX tag there, or the checker cannot resolve it to a declaration
 * with a body (a namespace import, a type-only re-export, or simply a
 * mismatch between what the fiber reported and what the source now says,
 * which an edit made between mount and click is enough to cause).
 */
export function resolveJsxComponent(options: {
  /** File containing the JSX usage. Absolute, or relative to `cwd`. */
  file: string;
  componentName: string;
  cwd?: string;
}): JsxComponentLocation | null {
  const cwd = options.cwd ?? process.cwd();
  const filePath = isAbsolute(options.file)
    ? options.file
    : resolve(cwd, options.file);

  if (!existsSync(filePath)) return null;

  let program: ReturnType<typeof getProjectProgram>["program"];
  let checker: ReturnType<typeof getProjectProgram>["checker"];
  let project: ReturnType<typeof getProjectProgram>["project"];
  let projectRoot: string;

  try {
    ({ checker, program, project, projectRoot } = getProjectProgram(
      dirname(filePath),
    ));
  } catch {
    return null;
  }

  const source = program.getSourceFile(filePath);
  if (!source) return null;

  for (const tagName of findJsxTags(source, options.componentName)) {
    let symbol = checker.getSymbolAtLocation(tagName);
    if (!symbol) continue;

    // The tag resolves to the *import binding* first —
    // `import { InspectorPanel } from "./inspector-panel"` — whose own
    // declaration is the import specifier itself, in the file doing the
    // importing. Following the alias is what reaches the component's real
    // declaration instead.
    if (symbol.flags & SymbolFlags.Alias) {
      symbol = checker.getAliasedSymbol(symbol);
    }

    const declaration = pickDeclaration(symbol.declarations, project);
    if (!declaration) continue;

    const declarationFile = declaration.getSourceFile().fileName;
    // A component resolved back to a .d.ts or node_modules is a type alias
    // or a re-export from a dependency, not Semla's own source — nothing
    // useful to open.
    if (declarationFile.includes("node_modules")) continue;

    return {
      file: displayPath(declarationFile, [cwd, projectRoot]),
      line: lineOf(declaration),
    };
  }

  return null;
}

/**
 * Hop inward through a chain of component names, one file at a time.
 *
 * The caller has a boundary file known to contain `chain[0]`'s JSX usage (the
 * one debug-stack resolution could still name — see the module doc) and,
 * from the fiber's *structural* parent chain, the ordered names of every
 * component between that boundary and the one actually clicked —
 * `chain[0]` outermost, the clicked element's own component last. Each hop
 * resolves one name to its declaration, then asks whether *that* file's own
 * JSX contains the next name, and so on. The furthest point reached is
 * returned even when the chain runs out early — a partial answer naming the
 * right component, several hops closer than the boundary, beats none because
 * the last hop could not be confirmed.
 */
export function resolveJsxComponentChain(options: {
  /** File containing the first name's JSX usage. */
  file: string;
  /** Outermost first, clicked element's own component last. */
  chain: readonly string[];
  cwd?: string;
}): JsxComponentLocation | null {
  let file = options.file;
  let best: JsxComponentLocation | null = null;

  for (const componentName of options.chain) {
    const located = resolveJsxComponent({
      componentName,
      cwd: options.cwd,
      file,
    });
    if (!located) break;

    best = located;
    file = located.file;
  }

  return best;
}
