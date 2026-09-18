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
import { useCallback } from "react";

import { useElementTarget } from "@/components/element-target-provider";
import { SessionSummaryCard } from "@/components/session/session-summary-card";
import { artifactTargetFor } from "@/components/sidebar/session-artifact-click";
import { Button } from "@/components/ui/button";
import { useSessionSummary } from "@/hooks/use-session-summary";
import type { ArtifactChip } from "@/lib/artifacts/artifact-summary";
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
      <div className="min-h-0 flex-1">
        <SessionSummaryCard onOpenArtifact={handleOpenArtifact} summary={summary} />
      </div>
    </div>
  );
}
