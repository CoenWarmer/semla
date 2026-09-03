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
/** What a panel opens at, and the floor a drag cannot go below. */
export const DEFAULT_PANEL_HEIGHT = 288;
const MIN_PANEL_HEIGHT = 96;
/** What "expand" means, and the ceiling a drag stops at. */
const EXPANDED_FRACTION = 0.8;
const MAX_FRACTION = 0.9;

/**
 * A height a drag is allowed to produce.
 *
 * Clamped against the viewport rather than a constant, because dragging a
 * panel taller than the window leaves the bar — and the handle that would undo
 * it — off the bottom of the screen.
 */
export const clampPanelHeight = (height: number, viewport: number): number =>
  Math.round(
    Math.min(Math.max(height, MIN_PANEL_HEIGHT), viewport * MAX_FRACTION),
  );

export const expandedPanelHeight = (viewport: number): number =>
  Math.round(viewport * EXPANDED_FRACTION);

/**
 * What the expand button does next.
 *
 * A toggle rather than a one-way switch, so the same button collapses it
 * again. "Already expanded" is a tolerance rather than equality: a drag lands
 * on whole pixels and a viewport fraction rarely does, so an exact test would
 * leave the button doing nothing at heights that look expanded.
 */
export const nextPanelHeight = (current: number, viewport: number): number => {
  const expanded = expandedPanelHeight(viewport);
  return Math.abs(current - expanded) <= 2
    ? clampPanelHeight(DEFAULT_PANEL_HEIGHT, viewport)
    : clampPanelHeight(expanded, viewport);
};

export type BottomPanelContext = {
  /** Element to render extra bar buttons into, once the bar has mounted. */
  barSlot: HTMLElement | null;
  /** Height of the open panel, in pixels. Shared, because the slot is. */
  height: number;
  /** Id of the open panel, or null when the bar is collapsed. */
  open: string | null;
  /** Element to render the open panel's content into. */
  panelSlot: HTMLElement | null;
  /** Drag the panel to a height, clamped to the viewport. */
  resize: (height: number) => void;
  /** Open this panel, or collapse the bar if it is already open. */
  toggle: (id: string) => void;
  /** Expand to 80% of the viewport, or back to the default height. */
  toggleExpanded: () => void;
};

const Context = createContext<BottomPanelContext | null>(null);

export function BottomPanelProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState<string | null>(null);
  // Callback refs rather than an effect: the slots are DOM nodes the bar
  // creates, and `react/set-state-in-effect` is an error in this repository
  // for good reason — a mount that sets state starts a second render.
  const [barSlot, setBarSlot] = useState<HTMLElement | null>(null);
  const [panelSlot, setPanelSlot] = useState<HTMLElement | null>(null);
  const [height, setHeight] = useState(DEFAULT_PANEL_HEIGHT);

  const toggle = useCallback((id: string) => {
    setOpen((current) => (current === id ? null : id));
  }, []);

  // `window` is read inside the handlers, never during render — this provider
  // renders on the server too.
  const resize = useCallback((next: number) => {
    setHeight(clampPanelHeight(next, window.innerHeight));
  }, []);

  const toggleExpanded = useCallback(() => {
    setHeight((current) => nextPanelHeight(current, window.innerHeight));
  }, []);

  const value = useMemo(
    () => ({
      barSlot,
      height,
      open,
      panelSlot,
      resize,
      setBarSlot,
      setPanelSlot,
      toggle,
      toggleExpanded,
    }),
    [barSlot, height, open, panelSlot, resize, toggle, toggleExpanded],
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
