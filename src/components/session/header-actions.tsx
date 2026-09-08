"use client";

import { useQuery } from "@tanstack/react-query";

import { useGlobalCost } from "@/hooks/use-global-cost";
import {
  fetchSingleSessionStatus,
  sessionStatusKey,
} from "@/lib/session-status";
import { useParams } from "next/navigation";
import { GitStatusBadge } from "../git-status-badge";
import { SessionProjectPicker } from "../session-project-picker";
import { TokenUsage } from "../token-usage";

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
        <span className="flex items-center gap-1" key={project.path}>
          <GitStatusBadge
            showProjectName
            showBorder
            // The session variant, not the workspace one: this is the indicator
            // being looked at, and it is where a stale ref actually misleads.
            target={{ kind: "session", path: project.path, sessionId }}
          />
          {project.otherActiveSessions > 0 && (
            // Phase 1 of docs/plans/session-isolation.md: nothing here blocks
            // anything, it just says the working tree, index and HEAD this
            // session is about to touch are shared with someone else right
            // now.
            <span
              className="rounded bg-amber-500/15 px-1.5 py-0.5 text-xs text-amber-600 dark:text-amber-400"
              title={`${project.otherActiveSessions} other session${
                project.otherActiveSessions === 1 ? "" : "s"
              } working in ${project.path} right now — commits, stashes and resets affect them too.`}
            >
              +{project.otherActiveSessions}
            </span>
          )}
        </span>
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

  return (
    <>
      <div className="flex grow items-center justify-center gap-3 px-4">
        {sessionId && <SessionProjectBadges sessionId={sessionId} />}
      </div>
      <div className="flex">
        <GlobalCostBadge />
      </div>
    </>
  );
}
