/**
 * The shape of a code map: what calls what, and what we could not determine.
 *
 * A diagram of code is only worth drawing if a reader can trust it, so the model
 * here keeps two things a prettier model would drop.
 *
 * `CodeMapEdge.sites` carries the call-site lines rather than a bare boolean,
 * because "A calls B" is checkable only if you can say where. Clicking an edge
 * should land on a line where the call actually appears.
 *
 * `CodeMap.unresolved` records calls that were seen but could not be resolved to
 * a declaration — a dynamically dispatched method, a callback held in a
 * variable, a call through an interface with no single implementation. These are
 * the honest gaps. Dropping them would produce a diagram that looks complete and
 * is not, which is worse than one that shows where it stops.
 */

/** What a node is, as far as the type checker could tell. */
export type CodeMapNodeKind =
  | "class"
  | "constructor"
  | "function"
  | "method"
  | "external";

export type CodeMapNode = {
  /** Stable across runs: `${file}#${name}@${line}`. */
  id: string;
  name: string;
  kind: CodeMapNodeKind;
  /** Workspace-relative, so ids survive a different checkout path. */
  file: string;
  line: number;
  /** Enclosing class or object literal, when the node is a method. */
  container: string | null;
  /**
   * Declared outside the project — node_modules or a lib.d.ts. Kept as a
   * boundary marker rather than walked into, so a map stays about your code.
   */
  external: boolean;
};

export type CodeMapEdge = {
  /** Node id of the caller. */
  from: string;
  /** Node id of the callee. */
  to: string;
  kind: "call" | "new";
  /** Lines in `from`'s file where this call appears. */
  sites: number[];
};

/** A call the walk saw but could not attach to a declaration. */
export type CodeMapUnresolved = {
  /** Node id of the enclosing function. */
  from: string;
  /** Text of the callee expression, as written. */
  name: string;
  line: number;
  /** Why the checker could not resolve it, in a phrase fit for a tooltip. */
  reason: string;
};

export type CodeMap = {
  /** Node id of the symbol the map was built from. */
  root: string;
  nodes: CodeMapNode[];
  edges: CodeMapEdge[];
  /** How many hops out from the root the walk was allowed to go. */
  depth: number;
  /**
   * True when the node cap stopped the walk before it ran out of callees, so the
   * panel can say "there is more" rather than implying the graph ends here.
   */
  truncated: boolean;
  unresolved: CodeMapUnresolved[];
};

/** Build a node id. Kept in one place so ids cannot drift between producers. */
export function codeMapNodeId(file: string, name: string, line: number): string {
  return `${file}#${name}@${line}`;
}
