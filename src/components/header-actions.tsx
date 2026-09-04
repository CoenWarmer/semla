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
import {
  fetchSingleSessionStatus,
  sessionStatusKey,
} from "@/lib/session-status";
import { FolderOpenIcon } from "lucide-react";
import { useParams } from "next/navigation";
import { useState } from "react";
import { ElementPicker } from "./element-picker";
import { GitStatusBadge } from "./git-status-badge";
import { SessionFilesPanel } from "./session-files-panel";
import { SessionProjectPicker } from "./session-project-picker";
import { SessionProjectsPanel } from "./session-projects-panel";
import { TokenUsage } from "./token-usage";

/**
 * One badge per project the session relates to, each named and showing what its
 * branch is doing.
 *
 * The links come from this session's own status query, which the session page
 * also reads — so a session in four repositories still makes one call. It used
 * to pick its row out of the sidebar's whole-list poll, which meant loading
 * every session on the machine to find the one already named in the URL.
 *
 * Every project is shown, with no cap. A session gains projects one write at a
 * time and in practice holds a handful; hiding one behind a "+N" would defeat
 * the point of showing them at all.
 */
function SessionProjectBadges({ sessionId }: { sessionId: string }) {
  const { data } = useQuery({
    queryKey: sessionStatusKey(sessionId),
    queryFn: () => fetchSingleSessionStatus(sessionId),
  });

  const projects = data?.projects ?? [];

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
      <SessionProjectPicker
        linkedPaths={new Set(projects.map((project) => project.path))}
        sessionId={sessionId}
      />
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
        Only where there is a session to open the Review panel on. The picker
        itself no-ops outside development, so this is about relevance rather
        than a second gate.
      */}
      {sessionId && <ElementPicker sessionId={sessionId} />}

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
            {/*
              Above the tree rather than beside it: the projects decide what the
              tree is rooted on, so reading them second would be reading the
              answer before the question.
            */}
            <SessionProjectsPanel sessionId={sessionId} />
            <div className="min-h-0 flex-1">
              <SessionFilesPanel sessionId={sessionId} />
            </div>
          </SheetContent>
        </Sheet>
      )}
    </>
  );
}
