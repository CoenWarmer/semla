"use client";

import { createPortal } from "react-dom";
import { useState, type ReactNode } from "react";

import { useBottomPanel } from "@/components/bottom-panel";
import { cn } from "@/lib/utils";

/**
 * A button in the bottom bar's row, with no panel underneath it.
 */
export function BottomBarButton({ children }: { children: ReactNode }) {
  const bar = useBottomPanel();
  if (!bar?.barSlot) return null;
  return createPortal(children, bar.barSlot);
}

/**
 * A button-and-panel pair that shares the bottom bar's row and expand area
 * with every other panel registered there — the same drag-to-resize, the
 * same "Expand" toggle, and the same one-open-at-a-time rule the shared bar
 * enforces.
 */
export function BottomBarPanel({
  button,
  children,
  keepMounted = false,
  panelId,
}: {
  button: (state: { open: boolean; toggle: () => void }) => ReactNode;
  children: ReactNode;
  /**
   * Keep the portal mounted, once opened, and toggle visibility with `hidden`
   * instead of unmounting it when the panel closes.
   *
   * Off by default: most panels have nothing to lose by unmounting, and
   * unmounting is what keeps them from doing work while collapsed. A consumer
   * that owns something long-lived — a socket, an observer, a terminal — asks
   * for this instead, so collapsing the bar hides it rather than tearing it
   * down and reconnecting on every toggle.
   *
   * The "has it ever been open" flag this needs is tracked as state set from
   * the toggle handler, not from an effect — `react/set-state-in-effect` is an
   * error in this repository, and there is nothing to synchronise here that a
   * render couldn't set directly.
   */
  keepMounted?: boolean;
  panelId: string;
}) {
  const bar = useBottomPanel();
  const [everOpened, setEverOpened] = useState(false);

  // Null outside the app frame, and the slots are null until the bar mounts.
  // Both mean "render nothing extra" rather than "throw".
  if (!bar) return null;

  const open = bar.open === panelId;
  const toggle = () => {
    bar.toggle(panelId);
    if (keepMounted) setEverOpened(true);
  };

  const shouldRenderPanel = keepMounted ? everOpened : open;

  return (
    <>
      {bar.barSlot && createPortal(button({ open, toggle }), bar.barSlot)}

      {shouldRenderPanel &&
        bar.panelSlot &&
        createPortal(
          <div className={cn("h-full overflow-hidden", !open && "hidden")}>
            {children}
          </div>,
          bar.panelSlot,
        )}
    </>
  );
}
