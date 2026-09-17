"use client";

import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import type { HunkAnchor } from "@/lib/artifacts/artifact-types";

/** Where the Review panel should open, resolved from a picked DOM element. */
export type ElementTarget = {
  path: string;
  project: string;
  /**
   * The line to jump to, or undefined when the caller named a file but no
   * line inside it.
   *
   * Optional rather than defaulted to 1, because "open this file" and "open
   * this file at line 1" are different requests and the panel acts on them
   * differently: with no line it leaves the editor's own
   * open-on-the-first-hunk behaviour alone (see `firstChangedLine` in
   * `code-editor.tsx`), which is the useful place to land in a file under
   * review. A `?? 1` here collapsed the two — the element picker always has
   * a real line, so nothing noticed until markdown file links became a
   * second caller and every unqualified `[foo](src/foo.ts)` started
   * scrolling to the top of the file instead.
   */
  line?: number;
  /**
   * Whether `line` is the exact clicked position, or only the nearest named
   * component's own declaration line — see `LocatedElement` in
   * `element-locator.ts`. The panel shows a notice for `"component"` rather
   * than silently opening a line that is not quite where the operator
   * clicked.
   */
  precision: "exact" | "component";
  /**
   * The hunk this target came from, as it stood when it was captured —
   * produced by a click on a session-item artifact chip. `ReviewPanel`
   * re-finds it against the live diff during render rather than trusting the
   * position (see `review-anchor-reveal.ts`); every other producer of a
   * target leaves this undefined.
   */
  anchor?: HunkAnchor | null;
  /** A commit to select in ReviewCommitNav, from a commit artifact chip. */
  commitSha?: string | null;
  /**
   * Unique per pick, including a second pick of the exact same file and line.
   *
   * `ReviewPanel` only reads its `initialTarget` prop once, on mount (see its
   * doc comment), so the caller has to force a remount for a new pick to take
   * effect — by keying on this rather than on the target's fields, which a
   * repeat pick would leave unchanged.
   */
  nonce: number;
};

export type ElementTargetStore = {
  target: ElementTarget | null;
  /** Set from the picker in the header. The nonce is assigned here. */
  request: (target: Omit<ElementTarget, "nonce">) => void;
  /** Cleared once the session component has opened the panel on it. */
  clear: () => void;
};

const Context = createContext<ElementTargetStore | null>(null);

/**
 * Carries a picked element's source location from the header — which only
 * knows a session id, not its tree — to the session component that owns the
 * Review panel.
 *
 * `ElementPicker` and `ClientSessionComponent` are siblings under the root
 * layout (see layout.tsx), not ancestor and descendant, so a prop cannot pass
 * between them; this is the same shape as `BottomPanelProvider` for the same
 * reason.
 *
 * A third producer, `SessionArtifactChips` in the sidebar, is a sibling of
 * both — the sidebar is also mounted above `{children}` in layout.tsx — and
 * requests a target the same way the picker does, carrying `anchor` and
 * `commitSha` where the picker leaves them undefined.
 */
export function ElementTargetProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<ElementTarget | null>(null);
  const nonceRef = useState(() => ({ current: 0 }))[0];

  // Memoized so the store's identity only changes when `target` actually
  // does. Consumers depend on this in effects and callbacks (ReviewPanel's
  // Escape listener, ElementPicker's pick-mode listeners) — an object
  // literal here would give every one of them a new identity on every render
  // of this provider, tearing down and re-adding document listeners
  // continuously while unrelated state elsewhere changes.
  const store = useMemo<ElementTargetStore>(
    () => ({
      clear: () => setTarget(null),
      request: (next) =>
        setTarget({ ...next, nonce: (nonceRef.current += 1) }),
      target,
    }),
    [nonceRef, target],
  );

  return <Context.Provider value={store}>{children}</Context.Provider>;
}

export function useElementTarget(): ElementTargetStore {
  const store = useContext(Context);
  if (!store) {
    throw new Error(
      "useElementTarget must be used inside an ElementTargetProvider.",
    );
  }
  return store;
}
