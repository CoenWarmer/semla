"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

/**
 * The bottom bar, shared between the frame and the page inside it.
 *
 * `AppConsole` sits in the root layout, outside `{children}`, because the bar
 * must stay put rather than scroll away with the page. The agent timeline it
 * now hosts is the opposite: its data — the snapshot, the spans, the live tool
 * calls — belongs to the session tree and arrives on that turn's stream.
 *
 * So neither side can own both. The bar owns which panel is open and provides
 * two slots; the session renders its button and its panel into them through
 * portals. Nothing is lifted, nothing is duplicated, and the session's state
 * stays where it is subscribed.
 *
 * One panel at a time, deliberately. Two stacked 288px panels leave a
 * conversation reading through a letterbox, and the bar is a place to glance
 * at one thing.
 */
export type BottomPanelContext = {
  /** Element to render extra bar buttons into, once the bar has mounted. */
  barSlot: HTMLElement | null;
  /** Id of the open panel, or null when the bar is collapsed. */
  open: string | null;
  /** Element to render the open panel's content into. */
  panelSlot: HTMLElement | null;
  /** Open this panel, or collapse the bar if it is already open. */
  toggle: (id: string) => void;
};

const Context = createContext<BottomPanelContext | null>(null);

export function BottomPanelProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState<string | null>(null);
  // Callback refs rather than an effect: the slots are DOM nodes the bar
  // creates, and `react/set-state-in-effect` is an error in this repository
  // for good reason — a mount that sets state starts a second render.
  const [barSlot, setBarSlot] = useState<HTMLElement | null>(null);
  const [panelSlot, setPanelSlot] = useState<HTMLElement | null>(null);

  const toggle = useCallback((id: string) => {
    setOpen((current) => (current === id ? null : id));
  }, []);

  const value = useMemo(
    () => ({ barSlot, open, panelSlot, setBarSlot, setPanelSlot, toggle }),
    [barSlot, open, panelSlot, toggle],
  );

  return <Context.Provider value={value}>{children}</Context.Provider>;
}

type ProviderValue = BottomPanelContext & {
  setBarSlot: (element: HTMLElement | null) => void;
  setPanelSlot: (element: HTMLElement | null) => void;
};

/**
 * The bar's own view, with the slot setters.
 *
 * Separate from `useBottomPanel` so a page cannot reassign the slots it is
 * supposed to be rendering into.
 */
export function useBottomPanelHost(): ProviderValue {
  const value = useContext(Context);
  if (!value) {
    throw new Error("useBottomPanelHost must be used inside a BottomPanelProvider.");
  }
  return value as ProviderValue;
}

/**
 * A page's view of the bar.
 *
 * Null-safe on purpose: a page rendered outside the frame — a test, or a route
 * that does not mount the console — should render nothing extra rather than
 * throw.
 */
export function useBottomPanel(): BottomPanelContext | null {
  return useContext(Context);
}
