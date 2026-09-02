/**
 * Turning TypeScript declarations into code map nodes.
 *
 * Most of this file exists because "a function" is not one thing in TypeScript.
 * `function f() {}`, `const f = () => {}`, `class C { m() {} }` and
 * `{ m() {} }` all produce callable declarations with different node types, and
 * a call graph that only understood the first would miss most of a modern
 * codebase — this repository included, where arrow functions assigned to consts
 * are the norm.
 *
 * The variable-declaration case matters twice over: the checker resolves a call
 * to `f` to the *variable*, not to the arrow function it holds, so walking into
 * a callee means unwrapping the initializer first.
 */

import { isAbsolute, relative } from "node:path";

import type {
  ArrowFunction,
  ClassDeclaration,
  ConstructorDeclaration,
  FunctionDeclaration,
  FunctionExpression,
  MethodDeclaration,
  Node,
} from "typescript/unstable/ast";
import {
  isArrowFunction,
  isClassDeclaration,
  isConstructorDeclaration,
  isExportAssignment,
  isFunctionDeclaration,
  isFunctionExpression,
  isIdentifier,
  isMethodDeclaration,
  isPropertyAssignment,
  isPropertyDeclaration,
  isVariableDeclaration,
} from "typescript/unstable/ast/is";

import { codeMapNodeId, type CodeMapNode, type CodeMapNodeKind } from "./types.ts";

/** Declaration kinds a code map treats as a node with a body worth walking. */
export type CallableDeclaration =
  | ArrowFunction
  | ClassDeclaration
  | ConstructorDeclaration
  | FunctionDeclaration
  | FunctionExpression
  | MethodDeclaration;

export function isCallableDeclaration(
  node: Node,
): node is CallableDeclaration {
  return (
    isFunctionDeclaration(node) ||
    isMethodDeclaration(node) ||
    isConstructorDeclaration(node) ||
    isArrowFunction(node) ||
    isFunctionExpression(node) ||
    isClassDeclaration(node)
  );
}

/**
 * Follow a declaration to the thing that actually has a body.
 *
 * `const handle = () => {}` resolves to the VariableDeclaration; the callable is
 * its initializer. Returns the input unchanged when there is nothing to unwrap.
 *
 * Takes a `Node` rather than a `Declaration` because it decides what it is
 * looking at structurally, with predicates. Requiring TS 7's branded
 * `Declaration` would mean callers casting a node they resolved from a symbol
 * handle — asserting the brand rather than checking it, to satisfy a function
 * that never needed it.
 */
export function unwrapDeclaration(node: Node): Node {
  if (isVariableDeclaration(node) && node.initializer) {
    if (
      isArrowFunction(node.initializer) ||
      isFunctionExpression(node.initializer)
    ) {
      return node.initializer;
    }
  }

  // `export default function () {}` and re-exported aliases land here.
  if (isExportAssignment(node) && node.expression) return node.expression;

  return node;
}

function kindOf(node: Node): CodeMapNodeKind {
  if (isClassDeclaration(node)) return "class";
  if (isConstructorDeclaration(node)) return "constructor";
  if (isMethodDeclaration(node)) return "method";
  return "function";
}

/**
 * The name a declaration carries, if it carries one.
 *
 * Replaces TS 5's `ts.getNameOfDeclaration`, which TS 7 does not export. The
 * property test is deliberately structural rather than a list of node kinds:
 * it covers every named declaration in one go, including the ones a call lands
 * on but a hand-written list forgets — MethodSignature on an interface (which
 * is what `Array.map` is), PropertySignature, ambient declarations.
 */
function nameOfDeclaration(node: Node): string | null {
  const named = node as { name?: { getText?: () => string } };
  const text = named.name?.getText?.();
  return text ? text : null;
}

/**
 * The name to show for a declaration.
 *
 * An anonymous arrow function assigned to a const takes the const's name, which
 * is what a reader calls it. A genuinely anonymous callback keeps a positional
 * label rather than being dropped — an unnamed node in the right place is more
 * informative than a missing edge.
 */
export function declarationName(node: Node): string {
  if (isConstructorDeclaration(node)) {
    const owner = node.parent;
    return isClassDeclaration(owner) && owner.name
      ? `${owner.name.getText()}.constructor`
      : "constructor";
  }

  const declared = nameOfDeclaration(node);
  if (declared) return declared;

  if (isArrowFunction(node) || isFunctionExpression(node)) {
    const parent = node.parent;
    if (isVariableDeclaration(parent) && isIdentifier(parent.name)) {
      return parent.name.getText();
    }
    if (isPropertyAssignment(parent)) return parent.name.getText();
    if (isPropertyDeclaration(parent) && parent.name) {
      return parent.name.getText();
    }
  }

  return `(anonymous):${lineOf(node)}`;
}

/** The class a method belongs to, for grouping in the diagram. */
export function containerName(node: Node): string | null {
  let current: Node | undefined = node.parent;

  while (current) {
    if (isClassDeclaration(current) && current.name) {
      return current.name.getText();
    }
    current = current.parent;
  }

  return null;
}

/**
 * Outside the project: a .d.ts, or anything under node_modules.
 *
 * External nodes are drawn as boundaries and never walked into. Following calls
 * into a dependency's internals would bury the code the question was about.
 */
export function isExternalFile(fileName: string): boolean {
  return fileName.endsWith(".d.ts") || fileName.includes("node_modules");
}

/** One-based line of a node, as a reader would cite it. */
export function lineOf(node: Node): number {
  const source = node.getSourceFile();
  return source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
}

/**
 * Shortest meaningful path for a file, tried against each root in order.
 *
 * The roots are the session's workspace first, the tsconfig's directory second.
 * That order matters in a monorepo: Kibana has a tsconfig.json inside every
 * plugin, so resolving against the tsconfig alone produced `server/plugin.ts`
 * for a file the caller had addressed as
 * `kibana/x-pack/platform/plugins/shared/significant_events/server/plugin.ts`.
 * Ambiguous across a hundred plugins, not clickable from the workspace, and not
 * the path the caller used — output should be addressable the same way input is.
 *
 * Falls back to the absolute path rather than an unreadable pile of `../`.
 */
export function displayPath(
  fileName: string,
  roots: readonly string[],
): string {
  for (const root of roots) {
    if (!root) continue;
    const rel = relative(root, fileName);
    if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return rel;
  }

  return fileName;
}

/** Build the code map node for a declaration. */
export function toCodeMapNode(
  node: Node,
  roots: readonly string[],
): CodeMapNode {
  const fileName = node.getSourceFile().fileName;
  const file = displayPath(fileName, roots);
  const name = declarationName(node);
  const line = lineOf(node);
  const external = isExternalFile(fileName);

  return {
    container: containerName(node),
    external,
    file,
    id: codeMapNodeId(file, name, line),
    kind: external ? "external" : kindOf(node),
    line,
    name,
  };
}
