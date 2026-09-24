"use client";

import type { ReactNode } from "react";

import { usePanelLayoutSaver, usePanelLayouts } from "@/hooks/use-panel-layout";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "../ui/resizable";

/**
 * The session page's resizable splits: review beside (or above) the
 * conversation, and the summary card beside the conversation.
 *
 * Both groups are always mounted, and the conversation panel keeps a stable
 * `key` in each, whatever else is showing. React matches children by type and
 * position at a slot, so a group that came and went with its panel — which is
 * how the summary split used to work — tore down and rebuilt everything under
 * it on every toggle, including PromptEditor's PromptInputProvider, silently
 * discarding whatever the operator had typed but not sent.
 *
 * Both groups are also keyed on the panel-layout fetch settling:
 * react-resizable-panels reads `defaultLayout` once, in its mount effect, and
 * never re-reads it. Without the key a group mounted on a cold reload keeps
 * the fallback layout for the life of the page, and the operator's drag looks
 * as though it never persisted.
 */
export function SessionLayout({
  conversation,
  review,
  reviewLayout,
  summary,
}: {
  conversation: ReactNode;
  /** The review panel, or null while it is closed. */
  review: ReactNode;
  reviewLayout: "horizontal" | "vertical";
  /** The summary card, or null while it is closed. */
  summary: ReactNode;
}) {
  const panelLayoutsQuery = usePanelLayouts();
  const panelLayouts = panelLayoutsQuery.data;
  const settled = panelLayoutsQuery.isPending ? "pending" : "ready";

  // Keyed by orientation so a horizontal drag does not leak into the vertical
  // layout's percentages.
  const reviewSplitKey = `review-split-${reviewLayout}`;
  const reviewSplitLayout = panelLayouts?.[reviewSplitKey] as Record<string, number> | undefined;
  const saveReviewSplit = usePanelLayoutSaver(reviewSplitKey);

  // One key with no orientation suffix: this split only ever runs side by
  // side, so there is no second preference a drag could leak into.
  const summarySplitLayout = panelLayouts?.["session-summary-split"] as
    | Record<string, number>
    | undefined;
  const saveSummarySplit = usePanelLayoutSaver("session-summary-split");

  const reviewOpen = review !== null;
  const summaryOpen = summary !== null;

  return (
    <ResizablePanelGroup
      // Remounted on layout flip: react-resizable-panels otherwise keeps the
      // user's dragged percentages across orientations, so an 80%-wide review
      // pane would become an 80%-tall one instead of resetting to a sane
      // split for the new axis. Not keyed on reviewOpen: that is exactly the
      // remount this group must not do.
      className="min-h-0 flex-1"
      defaultLayout={reviewOpen ? reviewSplitLayout : undefined}
      key={`${reviewLayout}-${settled}`}
      onLayoutChanged={(layout, meta) => {
        if (meta.isUserInteraction) saveReviewSplit(layout);
      }}
      orientation={reviewLayout}
    >
      {reviewOpen && (
        <ResizablePanel
          className="flex min-h-0 flex-col overflow-hidden border"
          defaultSize={45}
          id="review"
          key="review"
          minSize={20}
          // react-resizable-panels hardcodes `overflow: auto` inline on its
          // panels, which beats the `overflow-hidden` class. The review panel
          // and the conversation both manage their own scroll regions, so
          // without this each would grow a second scrollbar — here and on
          // every panel below.
          style={{ overflow: "hidden" }}
        >
          {review}
        </ResizablePanel>
      )}
      {reviewOpen && <ResizableHandle key="review-handle" withHandle />}
      <ResizablePanel
        className="flex min-h-0 flex-col overflow-hidden"
        defaultSize={reviewOpen ? 55 : 100}
        id="conversation"
        key="conversation"
        minSize={20}
        style={{ overflow: "hidden" }}
      >
        {/*
          Nested inside the review split rather than a third panel of it: the
          summary belongs to the conversation, so it must travel with it when
          the review panel flips orientation. As a third sibling, a vertical
          review layout would stack the card under the transcript and a
          horizontal one would squeeze three columns into the width of two.
        */}
        <ResizablePanelGroup
          className="min-h-0 flex-1"
          defaultLayout={summaryOpen ? summarySplitLayout : undefined}
          key={`summary-${settled}`}
          onLayoutChanged={(layout, meta) => {
            if (meta.isUserInteraction) saveSummarySplit(layout);
          }}
          orientation="horizontal"
        >
          <ResizablePanel
            className="flex min-h-0 flex-col overflow-hidden"
            defaultSize={summaryOpen ? 65 : 100}
            id="conversation"
            key="conversation"
            minSize={25}
            style={{ overflow: "hidden" }}
          >
            {conversation}
          </ResizablePanel>
          {summaryOpen && <ResizableHandle key="summary-handle" withHandle />}
          {summaryOpen && (
            <ResizablePanel
              className="flex min-h-0 flex-col overflow-hidden"
              defaultSize={35}
              id="summary"
              key="summary"
              minSize={15}
              style={{ overflow: "hidden" }}
            >
              {summary}
            </ResizablePanel>
          )}
        </ResizablePanelGroup>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
