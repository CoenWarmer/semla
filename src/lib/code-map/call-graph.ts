/**
 * Builds a code map by walking calls outward from one symbol.
 *
 * Every edge here is one the type checker resolved: the callee expression was
 * traced to a declaration with a file and a line. Calls that could not be traced
 * — a method on a value whose type is `any`, a callback held in a variable, a
 * dynamically built dispatch — are not silently dropped. They are recorded in
 * `unresolved`, so the map can show where it stops knowing rather than implying
 * the code stops there.
 *
 * Two deliberate choices about what counts as a call from a function:
 *
 *  - **Nested scopes are included.** A call inside `items.map(x => helper(x))`
 *    is attributed to the enclosing named function, because that is what someone
 *    asking "what does this function call" means. Excluding them would drop most
 *    of the interesting edges in a codebase written with callbacks.
 *  - **External declarations are boundaries.** Anything in node_modules or a
 *    .d.ts becomes a node but is never expanded. Following calls into a
 *    dependency's internals would bury the code the question was about.
 */

import { dirname, isAbsolute, resolve } from "node:path";

import ts from "typescript";

import {
  containerName,
  declarationName,
  isCallableDeclaration,
  isExternalFile,
  lineOf,
  toCodeMapNode,
  unwrapDeclaration,
} from "./declarations.ts";
import { getProjectProgram } from "./program.ts";
import type {
  CodeMap,
  CodeMapEdge,
  CodeMapNode,
  CodeMapUnresolved,
} from "./types.ts";

export const DEFAULT_DEPTH = 2;
export const DEFAULT_MAX_NODES = 60;

export type BuildCodeMapOptions = {
  /** File holding the entry symbol. Absolute, or relative to `cwd`. */
  file: string;
  /** Entry symbol: `handlePrompt`, or `ClassName.method` to disambiguate. */
  symbol: string;
  /** Hops outward from the entry. */
  depth?: number;
  /** Upper bound on nodes, so a hub symbol cannot draw the whole repository. */
  maxNodes?: number;
  /**
   * Draw calls into node_modules and the standard library. Off by default.
   *
   * Measured on this repository: a depth-2 map of `buildCodeMap` comes to 60
   * nodes with externals on, of which around 45 are `push`, `has`, `get`,
   * `includes` and friends — and it hits the node cap before it finishes the
   * calls that matter. The question "how does this code flow" is about the
   * project's own functions; `Array.prototype.push` is noise wearing the same
   * shape as signal.
   */
  includeExternal?: boolean;
  cwd?: string;
};

/** Raised with the names that *are* in the file, so a retry can succeed. */
export class SymbolNotFoundError extends Error {
  constructor(
    readonly symbol: string,
    readonly file: string,
    readonly candidates: string[],
  ) {
    const shown = candidates.slice(0, 25);
    const more = candidates.length - shown.length;
    super(
      `No callable declaration named "${symbol}" in ${file}. ` +
        (shown.length > 0
          ? `Declared here: ${shown.join(", ")}${more > 0 ? ` (+${more} more)` : ""}.`
          : "That file declares no functions, methods or classes."),
    );
    this.name = "SymbolNotFoundError";
  }
}

/** Every callable declaration in a file, with the label each answers to. */
function callableDeclarations(source: ts.SourceFile): Array<{
  label: string;
  node: ts.Node;
}> {
  const found: Array<{ label: string; node: ts.Node }> = [];

  const visit = (node: ts.Node) => {
    if (isCallableDeclaration(node)) {
      const name = declarationName(node);
      const container = containerName(node);
      found.push({
        label: container ? `${container}.${name}` : name,
        node,
      });
    }
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(source, visit);
  return found;
}

/** Pick the declaration matching `symbol`, by bare name or `Container.name`. */
function findEntry(source: ts.SourceFile, symbol: string): ts.Node {
  const declarations = callableDeclarations(source);

  const exact = declarations.find((entry) => entry.label === symbol);
  if (exact) return exact.node;

  // A bare name should still find `Class.method` when it is unambiguous.
  const byName = declarations.filter(
    (entry) => entry.label.split(".").pop() === symbol,
  );
  if (byName.length === 1) return byName[0].node;

  throw new SymbolNotFoundError(
    symbol,
    source.fileName,
    declarations.map((entry) => entry.label),
  );
}

/**
 * Prefer the declaration that has a body.
 *
 * Overloaded functions declare each signature separately; only the last carries
 * an implementation, and that is the one whose line a reader wants.
 */
function pickDeclaration(
  declarations: readonly ts.Declaration[],
): ts.Declaration | undefined {
  const withBody = declarations.find((declaration) => {
    const unwrapped = unwrapDeclaration(declaration);
    return (
      "body" in unwrapped &&
      (unwrapped as { body?: unknown }).body !== undefined
    );
  });

  return withBody ?? declarations[0];
}

/** Call and construction expressions anywhere inside a declaration. */
function callsWithin(declaration: ts.Node): Array<ts.CallExpression | ts.NewExpression> {
  const calls: Array<ts.CallExpression | ts.NewExpression> = [];

  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) calls.push(node);
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(declaration, visit);
  return calls;
}

export function buildCodeMap(options: BuildCodeMapOptions): CodeMap {
  const cwd = options.cwd ?? process.cwd();
  const filePath = isAbsolute(options.file)
    ? options.file
    : resolve(cwd, options.file);
  const depth = options.depth ?? DEFAULT_DEPTH;
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
  const includeExternal = options.includeExternal ?? false;

  const { checker, program, projectRoot } = getProjectProgram(
    dirname(filePath),
  );

  const source = program.getSourceFile(filePath);
  if (!source) {
    throw new Error(
      `${filePath} is not part of the TypeScript project rooted at ${projectRoot}. ` +
        "Check that it is covered by the tsconfig's include patterns.",
    );
  }

  const entry = findEntry(source, options.symbol);
  const rootNode = toCodeMapNode(entry, projectRoot);

  const nodes = new Map<string, CodeMapNode>([[rootNode.id, rootNode]]);
  const edges = new Map<string, CodeMapEdge>();
  const unresolved: CodeMapUnresolved[] = [];
  const expanded = new Set<string>();
  let truncated = false;

  let frontier: Array<{ declaration: ts.Node; id: string }> = [
    { declaration: entry, id: rootNode.id },
  ];

  for (let hop = 0; hop < depth && frontier.length > 0; hop += 1) {
    const next: Array<{ declaration: ts.Node; id: string }> = [];

    for (const current of frontier) {
      if (expanded.has(current.id)) continue;
      expanded.add(current.id);

      for (const call of callsWithin(current.declaration)) {
        const line = lineOf(call);
        const kind = ts.isNewExpression(call) ? "new" : "call";

        let symbol = checker.getSymbolAtLocation(call.expression);
        if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
          symbol = checker.getAliasedSymbol(symbol);
        }

        if (!symbol) {
          unresolved.push({
            from: current.id,
            line,
            name: call.expression.getText(),
            reason: "no symbol at the call site (dynamic or untyped)",
          });
          continue;
        }

        const declaration = pickDeclaration(symbol.declarations ?? []);
        if (!declaration) {
          unresolved.push({
            from: current.id,
            line,
            name: call.expression.getText(),
            reason: "symbol has no declaration in this program",
          });
          continue;
        }

        const target = unwrapDeclaration(declaration);
        const external = isExternalFile(target.getSourceFile().fileName);

        if (external && !includeExternal) continue;

        // Inside the project the symbol resolved, but not to something with an
        // implementation: a function-typed parameter, an interface member with
        // several implementors. Drawing a node would assert a call target the
        // checker never established — the invented edge this map exists to
        // avoid. Outside the project a signature is all there is, and naming the
        // boundary is genuinely useful, so those still become external nodes.
        if (!external && !isCallableDeclaration(target)) {
          unresolved.push({
            from: current.id,
            line,
            name: call.expression.getText(),
            reason:
              "declared but not implemented here (parameter, interface member or ambient signature)",
          });
          continue;
        }

        const targetNode = toCodeMapNode(target, projectRoot);

        if (!nodes.has(targetNode.id)) {
          if (nodes.size >= maxNodes) {
            truncated = true;
            continue;
          }
          nodes.set(targetNode.id, targetNode);
        }

        const edgeKey = `${current.id}->${targetNode.id}:${kind}`;
        const existing = edges.get(edgeKey);
        if (existing) {
          if (!existing.sites.includes(line)) existing.sites.push(line);
        } else {
          edges.set(edgeKey, {
            from: current.id,
            kind,
            sites: [line],
            to: targetNode.id,
          });
        }

        if (!external && !expanded.has(targetNode.id)) {
          next.push({ declaration: target, id: targetNode.id });
        }
      }
    }

    frontier = next;
  }

  // The walk stopped with callees still queued: the map is bounded by depth, not
  // by the code running out. Say so, the same way the node cap does.
  if (frontier.length > 0) truncated = true;

  return {
    depth,
    edges: [...edges.values()],
    nodes: [...nodes.values()],
    root: rootNode.id,
    truncated,
    unresolved,
  };
}
