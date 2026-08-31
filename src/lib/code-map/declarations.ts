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

import ts from "typescript";

import { codeMapNodeId, type CodeMapNode, type CodeMapNodeKind } from "./types.ts";

/** Declaration kinds a code map treats as a node with a body worth walking. */
export type CallableDeclaration =
  | ts.ArrowFunction
  | ts.ClassDeclaration
  | ts.ConstructorDeclaration
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.MethodDeclaration;

export function isCallableDeclaration(
  node: ts.Node,
): node is CallableDeclaration {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isClassDeclaration(node)
  );
}

/**
 * Follow a declaration to the thing that actually has a body.
 *
 * `const handle = () => {}` resolves to the VariableDeclaration; the callable is
 * its initializer. Returns the input unchanged when there is nothing to unwrap.
 */
export function unwrapDeclaration(node: ts.Declaration): ts.Node {
  if (ts.isVariableDeclaration(node) && node.initializer) {
    if (
      ts.isArrowFunction(node.initializer) ||
      ts.isFunctionExpression(node.initializer)
    ) {
      return node.initializer;
    }
  }

  // `export default function () {}` and re-exported aliases land here.
  if (ts.isExportAssignment(node) && node.expression) return node.expression;

  return node;
}

function kindOf(node: ts.Node): CodeMapNodeKind {
  if (ts.isClassDeclaration(node)) return "class";
  if (ts.isConstructorDeclaration(node)) return "constructor";
  if (ts.isMethodDeclaration(node)) return "method";
  return "function";
}

/**
 * The name to show for a declaration.
 *
 * An anonymous arrow function assigned to a const takes the const's name, which
 * is what a reader calls it. A genuinely anonymous callback keeps a positional
 * label rather than being dropped — an unnamed node in the right place is more
 * informative than a missing edge.
 */
export function declarationName(node: ts.Node): string {
  if (ts.isConstructorDeclaration(node)) {
    const owner = node.parent;
    return ts.isClassDeclaration(owner) && owner.name
      ? `${owner.name.getText()}.constructor`
      : "constructor";
  }

  // Covers every named declaration kind in one go, including the ones a call
  // lands on but a hand-written list forgets: MethodSignature on an interface
  // (which is what `Array.map` is), PropertySignature, ambient declarations.
  const declared = ts.getNameOfDeclaration(node as ts.Declaration);
  if (declared) return declared.getText();

  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    const parent = node.parent;
    if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
      return parent.name.getText();
    }
    if (ts.isPropertyAssignment(parent)) return parent.name.getText();
    if (ts.isPropertyDeclaration(parent) && parent.name) {
      return parent.name.getText();
    }
  }

  return `(anonymous):${lineOf(node)}`;
}

/** The class a method belongs to, for grouping in the diagram. */
export function containerName(node: ts.Node): string | null {
  let current: ts.Node | undefined = node.parent;

  while (current) {
    if (ts.isClassDeclaration(current) && current.name) {
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
export function lineOf(node: ts.Node): number {
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
  node: ts.Node,
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
