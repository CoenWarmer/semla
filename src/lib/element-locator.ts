"use client";

/**
 * DOM element -> source file:line, in development only.
 *
 * React's dev runtime stamps every fiber it creates with `_debugStack`: an
 * `Error` captured at the JSX call site, whose `.stack` names every frame
 * between that call and the top of the tree. That is enough to answer "what
 * line of Semla's own source rendered this" without any build-time
 * instrumentation (a Babel plugin, `__source` props) — the information is
 * already there in dev builds, React just does not expose it as a public API
 * beyond `captureOwnerStack`, which answers for the *currently rendering*
 * component rather than an arbitrary DOM node clicked from the mouse.
 *
 * **It is throttled, and the throttle is permanent per element.** React's dev
 * runtime only captures a real stack for the first ~10,000 elements created
 * within a second (`ReactSharedInternals.recentlyCreatedOwnerStacks`, capped
 * at `1e4` in `react-jsx-dev-runtime.development.js`); every element created
 * after that in the same burst gets a shared placeholder pointing at React's
 * own internal `UnknownOwner`, and it never gets a second chance — the
 * capture happens once, when the element is created, not on every render. A
 * client-rendered app's first paint routinely creates more than 10,000
 * elements in one go, so most of a mounted tree's `_debugStack`s are this
 * placeholder, permanently. Server Components are immune: their elements are
 * deserialized from Flight data through a code path the throttle never
 * touches, which is why the debug-stack walk below reliably resolves *up to*
 * a page's Server Component boundary and then silently stops improving from
 * there — the placeholder frames are rejected as unresolvable, but the
 * boundary is still a real, resolvable frame, so that is where it lands.
 *
 * The fallback for everything past that boundary is `resolveNameChain`: the
 * fiber's *structural* `.return` chain is never throttled — it is not a
 * captured stack, just "who is my parent" — so it can always name every
 * component between the boundary and the one actually clicked, even when none
 * of their debug stacks survived. Each name is then resolved server-side, one
 * hop at a time, by asking the type checker what a JSX tag with that name
 * resolves to in the previous hop's file (`jsx-component.ts`). That answers
 * with the component itself rather than the exact line inside it — a real
 * trade, not a lesser version of the debug-stack answer — because a name and
 * a JSX tag do not carry a line number the way a captured stack frame does.
 *
 * Both paths are React internals, undocumented and free to change between
 * versions. This is why the feature is dev-only and fails silently rather
 * than throwing where it might reach a user.
 */

/** One frame of a parsed `Error.stack`. */
interface RawFrame {
  file: string;
  methodName: string;
  line: number;
  column: number;
}

/** A frame resolved back to real source, relative to the project root. */
export interface LocatedElement {
  /**
   * The resolved source file, as Next's devtools endpoint reports it, or as
   * `resolveJsxComponentChain` reports it when the debug-stack path could not
   * get past a Server Component boundary.
   *
   * Not guaranteed to be project-relative: Turbopack's resolver returns an
   * absolute path there while webpack's already relativizes it. The caller
   * (`element-target/route.ts`) normalizes either shape server-side rather
   * than this module guessing at Next's bundler-dependent format.
   */
  file: string;
  line: number;
  column: number;
  /**
   * Whether `line`/`column` are the exact clicked position, or only the
   * component's own declaration line — the name-chain fallback's answer.
   * Callers that show a location to the operator should say so when this is
   * `"component"`, since a discrepancy here is not a bug in the resolution.
   */
  precision: "exact" | "component";
}

const FIBER_KEY_PREFIX = "__reactFiber$";

/** A React fiber, typed only as far as this module ever reads it. */
export type Fiber = {
  _debugStack?: unknown;
  _debugOwner?: Fiber | null;
  return?: Fiber | null;
  type?: unknown;
};

/** Find the nearest fiber a DOM node (or an ancestor) is keyed by. */
function nearestFiber(node: Node | null): Fiber | null {
  let current: Node | null = node;
  while (current) {
    const key = Object.keys(current).find((k) =>
      k.startsWith(FIBER_KEY_PREFIX),
    );
    if (key) {
      return (current as unknown as Record<string, unknown>)[key] as Fiber;
    }
    current = current.parentNode;
  }
  return null;
}

/** `Symbol.for("react.memo")` — the well-known, stable tag React itself uses
 * to mark a `memo()`-wrapped component's type. Referenced directly rather
 * than imported from React, because these symbols are exactly the part of
 * this mechanism that *is* public and stable (`Symbol.for` registers process-
 * wide, and React documents the wrapper types by these names in its own
 * source) — unlike `_debugStack`/`_debugOwner`, which are not. */
const REACT_MEMO_TYPE = Symbol.for("react.memo");
const REACT_LAZY_TYPE = Symbol.for("react.lazy");

/**
 * The component name React's own dev tooling would show for this fiber, or
 * null for a fiber that is not a component at all — a host element like
 * `<div>`, a text node, a fragment.
 *
 * Mirrors `getComponentNameFromType` in react's dev build: a function or
 * class component's name comes from `fiber.type` directly; `forwardRef`
 * wraps a `.render` function that carries the name instead; `memo` wraps
 * another type in `.type` and is unwrapped recursively, since a memoized
 * forwardRef (or a memoized memo, however unlikely) is legal; `lazy` names
 * nothing useful without calling its loader, which this will not do as a
 * side effect of inspecting a fiber — it is reported as `null` like a fiber
 * this cannot classify at all, which is the same "skip this hop, chain runs
 * shorter" degradation `resolveJsxComponentChain` already handles.
 */
export function componentName(fiber: Fiber, depth = 0): string | null {
  const type = fiber.type;
  if (depth > 5) return null;

  if (typeof type === "function") {
    const named = type as { displayName?: string; name?: string };
    // A true anonymous function's `.name` is `""`, not `undefined` — `??`
    // does not treat an empty string as absent, and this contract promises
    // null for "no name", not a name nobody would recognise.
    return named.displayName || named.name || null;
  }

  if (type && typeof type === "object") {
    const shape = type as {
      $$typeof?: symbol;
      displayName?: string;
      render?: unknown;
      type?: unknown;
    };

    if (typeof shape.render === "function") {
      const render = shape.render as { displayName?: string; name?: string };
      return shape.displayName || render.displayName || render.name || null;
    }

    if (shape.$$typeof === REACT_MEMO_TYPE && shape.type !== undefined) {
      return (
        shape.displayName || componentName({ type: shape.type }, depth + 1)
      );
    }

    if (shape.$$typeof === REACT_LAZY_TYPE) return null;
  }

  return null;
}

/**
 * Every frame in a fiber's own debug stack, then its owners' — outermost JSX
 * call sites last — paired with the fiber it came from.
 *
 * A fiber's `_debugStack` describes where *it* was created, which is usually
 * one frame inside the function component that rendered it (a `<div>` is
 * "created" by the component whose JSX built it). Walking `_debugOwner`
 * reaches further out — the caller of that component — for the case where the
 * innermost frame is inside a UI-library primitive Semla does not own.
 *
 * The fiber is kept alongside each stack (rather than returning only strings)
 * because the caller needs it twice: once to parse the stack itself, and
 * again — if every stack turns out unresolvable — to fall back to walking
 * this same chain by component name instead.
 */
function collectDebugStacks(fiber: Fiber): Array<{ fiber: Fiber; stack: string }> {
  const entries: Array<{ fiber: Fiber; stack: string }> = [];
  let current: Fiber | null = fiber;

  let hops = 0;
  while (current && hops < 20) {
    const stack = current._debugStack;
    if (stack instanceof Error && typeof stack.stack === "string") {
      entries.push({ fiber: current, stack: stack.stack });
    }
    current = current._debugOwner ?? current.return ?? null;
    hops += 1;
  }
  return entries;
}

/**
 * Component names from `from` down to (and including) `to`, outermost first.
 *
 * Walks the *structural* `return` chain — never `_debugOwner`, which is only
 * ever as reliable as the `_debugStack` it is bookkeeping for — so this is
 * unaffected by React's dev-stack throttle. `from` is expected to be an
 * ancestor of `to`; if the walk does not reach it within a generous bound, it
 * returns what it found, which the caller treats as a chain that ran out
 * rather than an error.
 */
export function nameChainBetween(from: Fiber, to: Fiber): string[] {
  // Walking parent-to-child is not possible on a fiber (there is no back
  // reference), so this collects child-to-parent first and reverses.
  const reversed: string[] = [];
  let current: Fiber | null = to;
  let hops = 0;

  while (current && current !== from && hops < 200) {
    const name = componentName(current);
    if (name) reversed.push(name);
    current = current.return ?? null;
    hops += 1;
  }

  return reversed.reverse();
}

/**
 * Parse an `Error.stack` string into frames with a resolvable file.
 *
 * V8's format is `    at name (file:line:col)` or `    at file:line:col` with
 * no name. Both webpack and Turbopack emit `webpack-internal://` or absolute
 * `file://` URLs here in dev, which is exactly what Next's own
 * `/__nextjs_original-stack-frames` endpoint (used by the built-in error
 * overlay) already knows how to resolve.
 */
function parseStackFrames(stack: string): RawFrame[] {
  const frames: RawFrame[] = [];
  const lines = stack.split("\n").slice(1); // first line is the Error's message

  for (const line of lines) {
    const match =
      /at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/.exec(line.trim()) ?? null;
    if (!match) continue;
    const [, methodName, file, lineStr, columnStr] = match;
    if (!file) continue;
    frames.push({
      column: Number(columnStr),
      file,
      line: Number(lineStr),
      methodName: methodName ?? "<unknown>",
    });
  }
  return frames;
}

/** Frames worth asking the server about: Semla's own code, not a library's. */
function isOwnSourceFrame(frame: RawFrame): boolean {
  if (frame.file.includes("node_modules")) return false;
  if (frame.file.startsWith("webpack-internal:///(rsc)")) return false;
  return true;
}

async function resolveFrame(frame: RawFrame): Promise<
  { file: string; line: number; column: number } | null
> {
  try {
    const res = await fetch("/__nextjs_original-stack-frames", {
      body: JSON.stringify({
        frames: [
          {
            column1: frame.column,
            file: frame.file,
            line1: frame.line,
            methodName: frame.methodName,
          },
        ],
        isAppDirectory: true,
        isEdgeServer: false,
        isServer: false,
      }),
      method: "POST",
    });
    if (!res.ok) return null;

    const [result] = (await res.json()) as Array<{
      status: "fulfilled" | "rejected";
      value?: {
        originalStackFrame?: {
          file: string | null;
          line1: number | null;
          column1: number | null;
          ignored: boolean;
        } | null;
      };
    }>;

    const resolved = result?.value?.originalStackFrame;
    if (
      !resolved ||
      resolved.ignored ||
      !resolved.file ||
      resolved.line1 == null
    ) {
      return null;
    }

    // Frames the resolver still reports as living in node_modules or the
    // framework are not Semla's own source, even once resolved.
    if (resolved.file.includes("node_modules")) return null;

    return {
      column: resolved.column1 ?? 1,
      file: resolved.file,
      line: resolved.line1,
    };
  } catch {
    return null;
  }
}

/**
 * Ask the server to hop a chain of component names inward from a resolved
 * boundary file, one JSX usage at a time. See `resolveJsxComponentChain` in
 * `jsx-component.ts` for what a hop actually does.
 */
async function resolveNameChain(
  boundaryFile: string,
  chain: readonly string[],
): Promise<{ file: string; line: number } | null> {
  if (chain.length === 0) return null;

  try {
    const res = await fetch("/api/dev/jsx-component-chain", {
      body: JSON.stringify({ chain, file: boundaryFile }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { file?: string; line?: number };
    return body.file && body.line ? { file: body.file, line: body.line } : null;
  } catch {
    return null;
  }
}

/**
 * Locate the Semla source file and line that rendered a clicked DOM element.
 *
 * Tries every frame in the fiber's own debug stack and then its owners',
 * nearest first, and returns the first that resolves to a file inside this
 * project — at the exact clicked line, when that frame survived React's dev
 * throttle. When none did (the common case for anything deep in a
 * client-rendered tree — see the module doc), falls back to resolving the
 * outermost frame that *did* resolve as a boundary, then hops inward through
 * the fiber's structural parent chain by component name from there. That
 * answer names the right component but only its own declaration line, not
 * the exact spot clicked, which is reported via `precision`.
 *
 * Returns null rather than throwing when React's internal shape does not
 * match what this was written against — the caller degrades to "nothing
 * found" rather than breaking the click.
 */
export async function locateElement(
  node: Element,
): Promise<LocatedElement | null> {
  const fiber = nearestFiber(node);
  if (!fiber) return null;

  const debugStacks = collectDebugStacks(fiber);

  // Walked nearest-first (the clicked fiber's own stack before any owner's),
  // so the first entry to resolve at all is kept as a candidate boundary —
  // but only a candidate. Whether it is the *exact* answer depends on which
  // fiber it came from: the clicked one itself (hop 0, precision "exact"),
  // or one reached only by walking owners because everything nearer was
  // React's throttled placeholder (precision "component", and the fiber
  // this resolved from becomes where the name-chain fallback starts).
  for (let hop = 0; hop < debugStacks.length; hop += 1) {
    const { fiber: owner, stack } = debugStacks[hop];
    const frames = parseStackFrames(stack).filter(isOwnSourceFrame);

    for (const frame of frames) {
      const located = await resolveFrame(frame);
      if (!located) continue;

      if (hop === 0) return { ...located, precision: "exact" };

      // `owner` resolved, but it is an ancestor's frame, not the clicked
      // element's own — the component names between it and the clicked
      // fiber are what is missing, and only the *structural* chain (never
      // throttled) can still name them.
      const chain = nameChainBetween(owner, fiber);
      const hopped = await resolveNameChain(located.file, chain);
      if (hopped) {
        return { column: 1, line: hopped.line, file: hopped.file, precision: "component" };
      }

      // The chain could not be hopped at all (e.g. it is empty, or the
      // boundary's own source no longer matches what the fiber reported) —
      // the boundary itself, named exactly, is still a real answer and a
      // closer one than nothing.
      return { ...located, precision: "component" };
    }
  }

  return null;
}
