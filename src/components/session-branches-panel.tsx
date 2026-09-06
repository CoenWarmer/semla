"use client";

import { useCallback, useState, Suspense } from "react";
import {
  useParams,
  usePathname,
  useRouter,
  useSearchParams,
} from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronDownIcon, ChevronUpIcon, GitBranchIcon } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { sessionPendingScrollKey } from "@/lib/session-live-state";
import { TurnGraphCanvas } from "@/components/turn-graph-canvas";
import { useTurnGraph } from "@/hooks/use-turn-graph";

export function SessionBranchesPanel() {
  const { id } = useParams<{ id?: string }>();
  const sessionId = id;
  const [open, setOpen] = useState(false);
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

  if (!sessionId || !hasBranches) {
    return null;
  }

  return (
    <div className="shrink-0 border-b border-border/40">
      <div className="flex h-11 items-center gap-2 px-6">
        <button
          aria-expanded={open}
          className="flex items-center gap-2 rounded px-1 tabular-nums text-muted-foreground transition-colors hover:text-foreground"
          onClick={() => setOpen((prev) => !prev)}
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
        </button>
      </div>
      {open && (
        <div className="h-[400px] overflow-hidden">
          <Suspense fallback={<Spinner className="size-4" />}>
            <TurnGraphCanvas
              onNodeClick={handleNodeClick}
              sessionId={sessionId}
            />
          </Suspense>
        </div>
      )}
    </div>
  );
}
