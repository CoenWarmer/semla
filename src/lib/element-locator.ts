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
 * Two things make this fragile by nature rather than by bug, so both ends are
 * defensive:
 *  - `_debugStack`/the fiber field names are React internals, undocumented and
 *    free to change between versions. This is why the feature is dev-only and
 *    fails silently rather than throwing where it might reach a user.
 *  - the frame format depends on the bundler (Turbopack vs. webpack) and on
 *    whether a source map round-trips. Frames are tried in order and the first
 *    one that resolves through Next's own devtools endpoint wins, rather than
 *    assuming a fixed frame index is always "the JSX call site".
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
   * The resolved source file, as Next's devtools endpoint reports it.
   *
   * Not guaranteed to be project-relative: Turbopack's resolver returns an
   * absolute path there while webpack's already relativizes it. The caller
   * (`element-target/route.ts`) normalizes either shape server-side rather
   * than this module guessing at Next's bundler-dependent format.
   */
  file: string;
  line: number;
  column: number;
}

const FIBER_KEY_PREFIX = "__reactFiber$";

/** Find the nearest fiber a DOM node (or an ancestor) is keyed by. */
function nearestFiber(node: Node | null): unknown {
  let current: Node | null = node;
  while (current) {
    const key = Object.keys(current).find((k) =>
      k.startsWith(FIBER_KEY_PREFIX),
    );
    if (key) return (current as unknown as Record<string, unknown>)[key];
    current = current.parentNode;
  }
  return null;
}

/**
 * Every frame in a fiber's own debug stack, then its owners' — outermost JSX
 * call sites last.
 *
 * A fiber's `_debugStack` describes where *it* was created, which is usually
 * one frame inside the function component that rendered it (a `<div>` is
 * "created" by the component whose JSX built it). Walking `_debugOwner`
 * reaches further out — the caller of that component — for the case where the
 * innermost frame is inside a UI-library primitive Semla does not own.
 */
function collectDebugStacks(fiber: unknown): string[] {
  const stacks: string[] = [];
  let current = fiber as {
    _debugStack?: unknown;
    _debugOwner?: unknown;
    return?: unknown;
  } | null;

  let hops = 0;
  while (current && hops < 20) {
    const stack = current._debugStack;
    if (stack instanceof Error && typeof stack.stack === "string") {
      stacks.push(stack.stack);
    }
    current =
      (current._debugOwner as typeof current) ??
      (current.return as typeof current) ??
      null;
    hops += 1;
  }
  return stacks;
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

async function resolveFrame(
  frame: RawFrame,
): Promise<LocatedElement | null> {
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
 * Locate the Semla source file and line that rendered a clicked DOM element.
 *
 * Tries every frame in the fiber's own debug stack and then its owners',
 * nearest first, and returns the first that resolves to a file inside this
 * project. Returns null rather than throwing when React's internal shape does
 * not match what this was written against — the caller degrades to "nothing
 * found" rather than breaking the click.
 */
export async function locateElement(
  node: Element,
): Promise<LocatedElement | null> {
  const fiber = nearestFiber(node);
  if (!fiber) return null;

  const stacks = collectDebugStacks(fiber);

  for (const stack of stacks) {
    const frames = parseStackFrames(stack).filter(isOwnSourceFrame);
    for (const frame of frames) {
      const located = await resolveFrame(frame);
      if (located) return located;
    }
  }

  return null;
}
