"use client";

import { ChevronDownIcon, ChevronUpIcon, GitForkIcon } from "lucide-react";
import { createPortal } from "react-dom";

import { useBottomPanel } from "@/components/bottom-panel";
import { TurnGraphCanvas } from "@/components/turn-graph-canvas";

/** This panel's id in the shared bottom bar. See bottom-panel.tsx. */
const BRANCHES_PANEL = "branches";

/**
 * The session's branch structure, in the bottom bar beside the agent
 * timeline.
 *
 * docs/plans/branching-sessions.md §4: "the panel belongs in the bottom bar,
 * through the slot mechanism bottom-panel.tsx documents." Modeled directly
 * on session-agents-panel.tsx — portalled into the bar's slots so the bar
 * itself never needs to know what a branch is, and mounted only while open,
 * since the graph holds no connection worth keeping alive collapsed.
 *
 * Unlike the agents panel, this is not conditionally shown: every session has
 * a branch structure, even a linear one with nothing yet to draw — and the
 * whole point of surfacing it is that a session gives no other sign a branch
 * exists at all.
 */
export function SessionBranchesPanel({
  onNodeClick,
  sessionId,
}: {
  /** The clicked turn's message id, forwarded from TurnGraphCanvas. */
  onNodeClick?: (turnId: string) => void;
  sessionId: string;
}) {
  const bar = useBottomPanel();

  // Null outside the app frame, and the slots are null until the bar mounts.
  // Both mean "render nothing extra" rather than "throw".
  if (!bar) return null;

  const open = bar.open === BRANCHES_PANEL;

  return (
    <>
      {bar.barSlot &&
        createPortal(
          <button
            aria-expanded={open}
            className="flex items-center gap-1.5 rounded px-1 text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => bar.toggle(BRANCHES_PANEL)}
            title="Show this session's branches"
            type="button"
          >
            <GitForkIcon className="size-3" />
            Branches
            {open ? (
              <ChevronDownIcon className="size-3" />
            ) : (
              <ChevronUpIcon className="size-3" />
            )}
          </button>,
          bar.barSlot,
        )}

      {open &&
        bar.panelSlot &&
        createPortal(
          <div className="h-full overflow-hidden p-2">
            <TurnGraphCanvas onNodeClick={onNodeClick} sessionId={sessionId} />
          </div>,
          bar.panelSlot,
        )}
    </>
  );
}
