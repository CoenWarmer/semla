"use client";

/**
 * The summary card's panel chrome: a header with a close button, and the card.
 *
 * Split from `SessionSummaryCard` so the card stays a pure function of a
 * `SessionSummary` — it is the piece worth rendering somewhere else later (a
 * session list row, a share view), and neither of those wants this panel's
 * close button. This component is the part that knows it lives in a resizable
 * panel next to the conversation.
 *
 * It is also where the data is fetched, via `useSessionSummary`, which keeps
 * `client-session-component.tsx` from growing a fourth query it would then
 * have to thread through props.
 */

import { XIcon } from "lucide-react";
import { useCallback, useState } from "react";

import { useElementTarget } from "@/components/element-target-provider";
import { SessionSummaryCard } from "@/components/session/session-summary-card";
import { artifactTargetFor } from "@/components/sidebar/session-artifact-click";
import { Button } from "@/components/ui/button";
import { useSessionSummary } from "@/hooks/use-session-summary";
import type { ArtifactChip } from "@/lib/artifacts/artifact-summary";
import type { WikiPageRef } from "@/lib/session/wiki-activity";
import type { WorkflowSnapshot } from "@/types/workflow";

export function SessionSummaryPanel({
  goal,
  model,
  onClose,
  sessionId,
  snapshot,
  title,
}: {
  goal: string | null;
  model: string | null;
  onClose: () => void;
  sessionId: string;
  snapshot?: WorkflowSnapshot;
  title: string | null;
}) {
  const summary = useSessionSummary({ goal, model, sessionId, snapshot, title });
  const elementTarget = useElementTarget();

  /**
   * Why the last wiki-page click didn't open anything.
   *
   * Unlike an artifact chip's target, a wiki page's location has to be asked
   * of the server — see wiki-page-source/route.ts — and the answer can
   * legitimately be "nowhere": the vault does not generally live inside a
   * session's attached projects. This is that answer, surfaced rather than
   * swallowed, the same way `openWorkspacePath` in review-panel.tsx reports a
   * Go to Definition that lands outside every attached project.
   */
  const [wikiPageNotice, setWikiPageNotice] = useState<string | null>(null);

  /**
   * Open a clicked artifact in the review panel.
   *
   * Requesting a target is all this has to do: `ClientSessionComponent`
   * derives `reviewOpen` from `elementTarget.target !== null`, so the panel
   * opens on its own and no second signal is needed. The same protocol, and
   * the same pure `artifactTargetFor`, the sidebar's chips already use — no
   * new click path, and none of the routing the sidebar needs, because this
   * panel is already on its session's page.
   */
  const handleOpenArtifact = useCallback(
    (chip: ArtifactChip) => {
      const next = artifactTargetFor(chip);
      if (next) elementTarget.request(next);
    },
    [elementTarget],
  );

  /**
   * Open a clicked wiki page in the review panel.
   *
   * A page id (`folder/slug`) is not a workspace path, so the project and
   * path the panel needs are resolved server-side rather than guessed at
   * here — see wiki-page-source/route.ts. A 404 there means the page's file
   * is not inside any project this session has attached, which is reported
   * rather than silently doing nothing.
   */
  const handleOpenWikiPage = useCallback(
    (page: WikiPageRef) => {
      setWikiPageNotice(null);

      void fetch(
        `/api/sessions/${sessionId}/wiki-page-source?id=${encodeURIComponent(page.id)}`,
      )
        .then(async (res) => {
          const body = (await res.json().catch(() => null)) as
            | { project: string; path: string }
            | { error: string }
            | null;

          if (!res.ok || !body || "error" in body) {
            setWikiPageNotice(
              body && "error" in body
                ? body.error
                : `Unable to open ${page.label}.`,
            );
            return;
          }

          elementTarget.request({
            path: body.path,
            precision: "exact",
            project: body.project,
          });
        })
        .catch(() => setWikiPageNotice(`Unable to open ${page.label}.`));
    },
    [elementTarget, sessionId],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1">
      <div className="flex shrink-0 items-center justify-between pl-1">
        <span className="text-xs font-medium text-muted-foreground">Summary</span>
        <Button
          aria-label="Close summary"
          className="size-6"
          onClick={onClose}
          size="icon"
          variant="ghost"
        >
          <XIcon className="size-3.5" />
        </Button>
      </div>
      {wikiPageNotice && (
        <p className="shrink-0 px-1 text-xs text-destructive">{wikiPageNotice}</p>
      )}
      <div className="min-h-0 flex-1">
        <SessionSummaryCard
          onOpenArtifact={handleOpenArtifact}
          onOpenWikiPage={handleOpenWikiPage}
          summary={summary}
        />
      </div>
    </div>
  );
}
