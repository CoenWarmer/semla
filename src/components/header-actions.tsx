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
import { GitStatusBadge } from "./git-status-badge";
import { SessionFilesPanel } from "./session-files-panel";
import { TokenUsage } from "./token-usage";

function GlobalCostBadge() {
  const { data } = useGlobalCost();
  if (!data) return null;
  // Cost only: the header is tight, and the tooltip carries the token count.
  return (
    <TokenUsage
      className="text-xs text-muted-foreground"
      cost={data.cost}
      costOnly
      title={`Total across all sessions: ${data.tokens.toLocaleString()} tokens`}
      tokens={data.tokens}
    />
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

      {/*
        Branch and spend sit together on the right: both are about the session's
        surroundings rather than the conversation, and both are read at a glance
        rather than acted on mid-thought. The badge renders nothing off a session
        page, so the group collapses to the cost on its own.
      */}
      <div className="ml-auto flex items-center gap-3 px-4">
        {sessionId && (
          <GitStatusBadge target={{ kind: "session", sessionId }} />
        )}
        <GlobalCostBadge />
      </div>

      {sessionId && (
        <Sheet open={filesOpen} onOpenChange={setFilesOpen}>
          {/*
            Left, alongside the sidebar: files are navigation, and the same
            side as every other way of getting somewhere in the app. Opening
            over the conversation on the right also covered the thing you were
            reading the file in aid of.
          */}
          <SheetContent
            className="flex flex-col gap-0 p-0 sm:max-w-2xl"
            side="left"
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
