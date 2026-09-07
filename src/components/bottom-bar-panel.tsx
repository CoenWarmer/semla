"use client";

import { createPortal } from "react-dom";
import type { ReactNode } from "react";

import { useBottomPanel } from "@/components/bottom-panel";

/**
 * One more button in the bottom bar's row, with no panel underneath it.
 *
 * `ElementPicker` is the one consumer this fits: it toggles its own local
 * "picking" mode rather than the bar's shared open/close panel, so there is
 * nothing here to coordinate with `AppConsole`'s toggle/height/expand state
 * — only a button that needs to sit in the same row as the others.
 */
export function BottomBarButton({ children }: { children: ReactNode }) {
  const bar = useBottomPanel();
  if (!bar?.barSlot) return null;
  return createPortal(children, bar.barSlot);
}

/**
 * A button-and-panel pair that shares the bottom bar's row and expand area
 * with every other panel registered there — the same drag-to-resize, the
 * same "Expand" toggle, and the same one-open-at-a-time rule `AppConsole`
 * enforces.
 *
 * Consumers hand this a `panelId` (their key into the shared `open` state),
 * a button, and the panel's content — nothing here about *what* an agent
 * timeline or a branch graph is. That split is why this exists:
 * `SessionAgentsPanel`, `SessionBranchesPanel` and `AppConsole` itself used
 * to each reimplement `useBottomPanel()` plus a `createPortal` pair plus the
 * `bar.open === MY_ID` check, and the actual difference between them was
 * never that plumbing — it was the button's label and the panel's contents.
 *
 * `button` is a render prop rather than a plain node because the button's
 * own look (expanded chevron, aria-expanded) depends on `open`, and `toggle`
 * is what its `onClick` needs — a plain node would leave the caller building
 * that closure anyway, just outside this component instead of inside it.
 *
 * `children` is only rendered while `open`: a collapsed panel that mounted
 * its content anyway would run every hook and subscription a closed panel
 * has no need for. A caller that wants to keep something mounted while
 * collapsed (`AppConsole`'s own terminal, once it has ever been opened) does
 * that itself, since this component owns none of that state.
 */
export function BottomBarPanel({
  button,
  children,
  panelId,
}: {
  button: (state: { open: boolean; toggle: () => void }) => ReactNode;
  children: ReactNode;
  panelId: string;
}) {
  const bar = useBottomPanel();
  // Null outside the app frame, and the slots are null until the bar mounts.
  // Both mean "render nothing extra" rather than "throw".
  if (!bar) return null;

  const open = bar.open === panelId;
  const toggle = () => bar.toggle(panelId);

  return (
    <>
      {bar.barSlot && createPortal(button({ open, toggle }), bar.barSlot)}

      {open &&
        bar.panelSlot &&
        createPortal(
          <div className="h-full overflow-hidden">{children}</div>,
          bar.panelSlot,
        )}
    </>
  );
}
