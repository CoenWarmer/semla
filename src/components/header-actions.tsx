"use client";

import { useQuery } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useGlobalCost } from "@/hooks/use-global-cost";
import { fetchSessionStatus, SESSION_STATUS_KEY } from "@/lib/session-status";
import { FolderOpenIcon } from "lucide-react";
import { useParams } from "next/navigation";
import { useState } from "react";
import { GitStatusBadge } from "./git-status-badge";
import { SessionFilesPanel } from "./session-files-panel";
import { TokenUsage } from "./token-usage";

/**
 * One badge per project the session relates to, each named and showing what its
 * branch is doing.
 *
 * The links come from the session-status poll the sidebar already runs, so this
 * costs no request of its own — and the badges themselves share a single query
 * keyed on the session, so a session in four repositories still makes one call.
 *
 * Every project is shown, with no cap. A session gains projects one write at a
 * time and in practice holds a handful; hiding one behind a "+N" would defeat
 * the point of showing them at all.
 */
function SessionProjectBadges({ sessionId }: { sessionId: string }) {
  const { data } = useQuery({
    queryKey: SESSION_STATUS_KEY,
    queryFn: fetchSessionStatus,
  });

  const projects = data?.find((s) => s.id === sessionId)?.projects ?? [];

  return (
    <>
      {projects.map((project) => (
        <GitStatusBadge
          key={project.path}
          showProjectName
          showBorder
          // The session variant, not the workspace one: this is the indicator
          // being looked at, and it is where a stale ref actually misleads.
          target={{ kind: "session", path: project.path, sessionId }}
        />
      ))}
    </>
  );
}

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

      <div className="flex grow items-center justify-center gap-3 px-4">
        {sessionId && <SessionProjectBadges sessionId={sessionId} />}
      </div>
      <div className="flex">
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
