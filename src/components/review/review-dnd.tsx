"use client";

/**
 * Drag-to-stage: dragging a changed-file row between the "Staged" bucket and
 * the "To review" list is a shortcut for staging or unstaging that file as a
 * whole — the same thing "Stage all" / "Unstage all" already do per hunk
 * group, reached by drag instead of by opening the row and clicking a button.
 *
 * Built on dnd-kit (https://dndkit.com/) rather than native HTML5 drag: the
 * two buckets already live in ordinary flow layout inside a resizable panel,
 * and dnd-kit's pointer sensor plus `DragOverlay` give a row that visibly
 * follows the cursor without fighting that layout the way native drag images
 * and `dragover` scroll containers tend to.
 *
 * Every row keeps its click-to-open behaviour. The drag surface is a small
 * grip handle (`DragHandle`), not the row itself — dnd-kit's own recommended
 * pattern for exactly this conflict, so a click on the filename still opens
 * the row and only a press-and-drag on the grip starts a drag.
 *
 * This module only knows drag *mechanics*: which row is being dragged, and
 * which bucket it landed in. It does not know how to stage anything — that is
 * `onStageWholeFile` in review-panel.tsx, wired in as a plain callback so the
 * git side of staging stays exactly where the rest of it already lives.
 */

import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { CSS, type Transform } from "@dnd-kit/utilities";
import { GripVerticalIcon } from "lucide-react";
import { useCallback, useState, type CSSProperties, type ReactNode } from "react";

import { cn } from "@/lib/utils";

import type { FileSelection } from "./review-changed-files";

/** Which bucket a row is in, or being dropped into. */
export type ReviewBucket = "staged" | "unstaged";

/** One project's drop target for one bucket. Scoped by project because
 * staging is a per-repository git operation — a row must never be droppable
 * into another project's bucket. */
export interface ReviewDropZone {
  project: string;
  bucket: ReviewBucket;
}

const dropZoneId = (zone: ReviewDropZone) =>
  `review-drop:${zone.bucket}:${zone.project}`;

/** Carried on the draggable so `onDragEnd` knows what moved and from where. */
export interface FileDragData {
  selection: FileSelection;
  from: ReviewBucket;
  /** For the drag overlay, which has no row of its own to read this from. */
  label: string;
}

const dragId = (selection: FileSelection, from: ReviewBucket) =>
  `review-drag:${from}:${selection.project}/${selection.path}`;

/**
 * One row's drag wiring: an id derived from its bucket and path, and the
 * payload `onDragEnd` reads off `active.data.current`.
 *
 * `from` is part of the id, not just the payload, because a file that is
 * partly staged and partly not is drawn as two separate rows — one in each
 * bucket — and they must be two distinct draggables.
 */
export function useFileDrag(selection: FileSelection, from: ReviewBucket, label: string) {
  const data: FileDragData = { from, label, selection };
  return useDraggable({ data, id: dragId(selection, from) });
}

/**
 * The grip a row exposes to start a drag.
 *
 * Deliberately not the whole row: `ReviewChangedFiles`' click-to-open and
 * this drag would otherwise compete for the same pointerdown, and dnd-kit's
 * own guidance for that conflict is a dedicated handle rather than an
 * activation-distance heuristic on the row itself.
 */
export function DragHandle({
  attributes,
  isDragging,
  listeners,
}: {
  attributes: ReturnType<typeof useDraggable>["attributes"];
  isDragging: boolean;
  listeners: ReturnType<typeof useDraggable>["listeners"];
}) {
  return (
    <span
      {...attributes}
      {...listeners}
      className={cn(
        "flex shrink-0 touch-none items-center self-center text-muted-foreground/50 hover:text-muted-foreground",
        isDragging ? "cursor-grabbing" : "cursor-grab",
      )}
      title="Drag to stage or unstage this file"
    >
      <GripVerticalIcon className="size-3" />
    </span>
  );
}

/** Inline style that makes a dragged row follow the pointer. */
export function dragTransformStyle(
  transform: Transform | null,
): CSSProperties | undefined {
  if (!transform) return undefined;
  return { transform: CSS.Translate.toString(transform) };
}

/**
 * The container one bucket's rows live in, made droppable.
 *
 * The ring is the only feedback a drop target gets — there is no room in
 * either bucket's header for text, and a border that appears only while
 * something is over it is the usual affordance for "this is a valid target".
 */
export function ReviewDropZoneArea({
  bucket,
  children,
  className,
  project,
}: {
  bucket: ReviewBucket;
  children: ReactNode;
  className?: string;
  project: string;
}) {
  const zone: ReviewDropZone = { bucket, project };
  const { isOver, setNodeRef } = useDroppable({ data: zone, id: dropZoneId(zone) });

  return (
    <div
      className={cn(
        "rounded transition-colors",
        isOver && "ring-1 ring-inset ring-primary bg-accent/20",
        className,
      )}
      ref={setNodeRef}
    >
      {children}
    </div>
  );
}

/**
 * The provider every draggable and drop zone in the changed-files list sits
 * under, plus the overlay that follows the cursor while dragging.
 *
 * One `DndContext` for the whole list, not one per project: dropping across
 * projects is rejected in `onDrop` (by comparing `zone.project` to
 * `from.project`) rather than by scoping the context, since a single context
 * is what lets dnd-kit report `isOver` correctly as the pointer crosses
 * between two projects' buckets while a drag is in progress.
 *
 * `PointerSensor` only — no keyboard sensor. Every row this feature moves has
 * a keyboard route already (the stage/unstage buttons, and `s`/`u` in
 * review-hunk-keyboard.ts); drag is an additional pointer shortcut on top of
 * those, not a replacement that would need its own keyboard equivalent.
 */
export function ReviewDndProvider({
  children,
  onDrop,
}: {
  children: ReactNode;
  /** Called only for a real move: a drop back onto its own bucket is not reported. */
  onDrop: (selection: FileSelection, direction: "stage" | "unstage") => void;
}) {
  const [dragging, setDragging] = useState<FileDragData | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 4 },
    }),
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setDragging(null);
      const from = event.active.data.current as FileDragData | undefined;
      const zone = event.over?.data.current as ReviewDropZone | undefined;
      if (!from || !zone) return;
      if (zone.project !== from.selection.project) return;
      if (zone.bucket === from.from) return;
      onDrop(from.selection, zone.bucket === "staged" ? "stage" : "unstage");
    },
    [onDrop],
  );

  return (
    <DndContext
      onDragCancel={() => setDragging(null)}
      onDragEnd={handleDragEnd}
      onDragStart={(event) =>
        setDragging((event.active.data.current as FileDragData | undefined) ?? null)
      }
      sensors={sensors}
    >
      {children}

      <DragOverlay>
        {dragging ? (
          <div className="flex items-center gap-2 rounded border bg-popover px-2 py-1 text-xs shadow-md">
            <GripVerticalIcon className="size-3 text-muted-foreground" />
            <span className="truncate">{dragging.label}</span>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
