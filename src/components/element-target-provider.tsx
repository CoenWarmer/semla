"use client";

import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

/** Where the Review panel should open, resolved from a picked DOM element. */
export type ElementTarget = {
  path: string;
  project: string;
  /** The line the fiber's debug stack named, so the editor can jump to it. */
  line: number;
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
