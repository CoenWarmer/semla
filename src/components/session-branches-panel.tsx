"use client";

import { useCallback, Suspense } from "react";
import { createPortal } from "react-dom";
import {
  useParams,
  usePathname,
  useRouter,
  useSearchParams,
} from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronDownIcon, ChevronUpIcon, GitBranchIcon } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { useBottomPanel } from "@/components/bottom-panel";
import { sessionPendingScrollKey } from "@/lib/session-live-state";
import { TurnGraphCanvas } from "@/components/turn-graph-canvas";
import { useTurnGraph } from "@/hooks/use-turn-graph";

/** This panel's id in the shared bottom bar. See bottom-panel.tsx. */
const BRANCHES_PANEL = "branches";

/**
 * Shares the bottom bar's button row and expand area with the console, the
 * agent timeline and the element picker — see session-agents-panel.tsx's
 * doc comment for why a portal here and hooks for the data are not in
 * tension.
 */
export function SessionBranchesPanel() {
  const { id } = useParams<{ id?: string }>();
  const sessionId = id;
  const bar = useBottomPanel();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();

  const graphQuery = useTurnGraph(sessionId ?? "", !!sessionId);
  const graph = graphQuery.data;
  const hasBranches = graph && graph.nodes.length > 1;

  const handleNodeClick = useCallback(
    (turnId: string, isLive: boolean) => {
      if (!sessionId) return;
      queryClient.setQueryData(sessionPendingScrollKey(sessionId), turnId);

      const next = new URLSearchParams(searchParams);
      if (isLive) next.delete("leaf");
      else next.set("leaf", turnId);
      const query = next.toString();
      router.push(`${pathname}${query ? `?${query}` : ""}`);
    },
    [queryClient, sessionId, router, pathname, searchParams],
  );

  if (!bar || !sessionId || !hasBranches) {
    return null;
  }

  const open = bar.open === BRANCHES_PANEL;

  return (
    <>
      {bar.barSlot &&
        createPortal(
          <button
            aria-expanded={open}
            className="flex items-center gap-2 rounded px-1 tabular-nums text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => bar.toggle(BRANCHES_PANEL)}
            title="Show branch graph"
            type="button"
          >
            <GitBranchIcon className="size-4" />
            {graph?.nodes.length ?? 0} turns
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
          <div className="h-full overflow-hidden">
            <Suspense fallback={<Spinner className="size-4" />}>
              <TurnGraphCanvas
                onNodeClick={handleNodeClick}
                sessionId={sessionId}
              />
            </Suspense>
          </div>,
          bar.panelSlot,
        )}
    </>
  );
}
