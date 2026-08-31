/**
 * A file with a call structure known by hand, so the extractor can be checked
 * against something whose right answer is not in doubt.
 *
 * Not a test itself, and deliberately not exciting: each declaration exists to
 * exercise one shape the checker resolves differently — a plain function, an
 * arrow assigned to a const, a method, a call made inside a callback, a call
 * through a function-typed parameter, and a call into the standard library.
 *
 * Editing this file will change the assertions in call-graph.test.ts. That is
 * the point: the line numbers are part of the contract, because an edge you
 * cannot locate is an edge you cannot check.
 */

/** Leaf of the graph — calls nothing declared in this project. */
export function trim(value: string): string {
  return value.trim();
}

/** An arrow function held in a const, which resolves to the variable first. */
export const normalise = (value: string): string => trim(value);

/** Calls into a callback, and into the standard library. */
export function normaliseAll(values: string[]): string[] {
  return values.map((value) => normalise(value));
}

export class Pipeline {
  /** A method, so container grouping has something to group. */
  run(values: string[]): string[] {
    return normaliseAll(values);
  }
}

/** Constructs a class, so `new` edges are exercised. */
export function makePipeline(): Pipeline {
  return new Pipeline();
}

/**
 * Calls a function it was handed. The checker resolves `apply` to the parameter
 * declaration, which has no body — the map must report this rather than invent a
 * node for it.
 */
export function invoke(apply: (value: string) => string): string {
  return apply("x");
}

/** Mutual recursion, so a cycle exists for the layout to survive. */
export function ping(count: number): number {
  return count <= 0 ? 0 : pong(count - 1);
}

export function pong(count: number): number {
  return ping(count - 1);
}
