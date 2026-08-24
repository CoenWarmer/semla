"use client";

import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useGlobalCost } from "@/hooks/use-global-cost";
import { FolderOpenIcon } from "lucide-react";
import { useParams } from "next/navigation";
import { useState } from "react";
import { SessionFilesPanel } from "./session-files-panel";

function formatCost(cost: number): string {
  if (cost < 0.001) return `$${cost.toFixed(5)}`;
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(3)}`;
}

function GlobalCostBadge() {
  const { data } = useGlobalCost();
  if (!data || data.cost <= 0) return null;
  return (
    <span
      className="text-xs tabular-nums text-muted-foreground"
      title="Total cost across all sessions"
    >
      {formatCost(data.cost)}
    </span>
  );
}

export function HeaderActions() {
  const params = useParams();
  const sessionId = typeof params?.id === "string" ? params.id : null;
  const [filesOpen, setFilesOpen] = useState(false);

  return (
    <>
      {sessionId && (
        <Button size="sm" variant="ghost" onClick={() => setFilesOpen(true)}>
          <FolderOpenIcon />
          Files
        </Button>
      )}

      <div className="ml-auto">
        <GlobalCostBadge />
      </div>

      {sessionId && (
        <Sheet open={filesOpen} onOpenChange={setFilesOpen}>
          <SheetContent
            className="flex flex-col gap-0 p-0 sm:max-w-2xl"
            side="right"
          >
            <SheetHeader className="shrink-0 border-b px-6 py-4">
              <SheetTitle>Files</SheetTitle>
            </SheetHeader>
            <div className="min-h-0 flex-1">
              <SessionFilesPanel sessionId={sessionId} />
            </div>
          </SheetContent>
        </Sheet>
      )}
    </>
  );
}
