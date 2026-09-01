"use client";

/**
 * The work a run of silent turns did, as a strip of dots.
 *
 * These turns used to render as empty bubbles — fifteen of them in a row in the
 * session that prompted this — because the conversation prints text and they
 * carry only reasoning and tool calls. They are not nothing, so they are not
 * dropped; they are folded into one line, one dot per step, and the contents
 * move into a drawer.
 *
 * A dot is deliberately small and unlabelled. The strip sits between a question
 * and its answer, where the reader's attention belongs to those two things; the
 * steps are available, not advertised.
 */

import { BrainIcon, WrenchIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { summariseSteps, type StepItem } from "@/lib/session-steps";
import { cn } from "@/lib/utils";

const DRAWER_WIDTH = 560;

function StepDetail({ item }: { item: StepItem }) {
  if (item.kind === "thinking") {
    return (
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-1.5 text-muted-foreground text-xs">
          <BrainIcon className="size-3.5 shrink-0" />
          Thinking
        </div>
        <p className="whitespace-pre-wrap text-sm leading-relaxed">{item.text}</p>
      </div>
    );
  }

  const { call } = item;

  return (
    <div className="flex flex-col gap-1">
      <div
        className={cn(
          "flex items-center gap-1.5 text-xs",
          call.isError ? "text-destructive" : "text-muted-foreground",
        )}
      >
        <WrenchIcon className="size-3.5 shrink-0" />
        <span className="font-medium">{call.name}</span>
        {call.summary && (
          <span className="truncate font-mono text-[11px]">{call.summary}</span>
        )}
      </div>

      {call.params && Object.keys(call.params).length > 0 && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-[11px]">
          {Object.entries(call.params).map(([key, value]) => (
            <div className="contents" key={key}>
              <dt className="text-muted-foreground">{key}</dt>
              <dd className="truncate font-mono">{value}</dd>
            </div>
          ))}
        </dl>
      )}

      {(call.errorText ?? call.resultText) && (
        <pre
          className={cn(
            "max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-2 text-[11px] leading-relaxed",
            call.isError && "text-destructive",
          )}
        >
          {call.errorText ?? call.resultText}
        </pre>
      )}
    </div>
  );
}

export function SessionStepsStrip({ items }: { items: StepItem[] }) {
  const [openAt, setOpenAt] = useState<string | null>(null);
  const detailRefs = useRef(new Map<string, HTMLDivElement | null>());

  // Open on the dot that was clicked rather than at the top: with a dozen steps
  // in the drawer, landing anywhere else means hunting for the one you asked for.
  useEffect(() => {
    if (!openAt) return;
    const target = detailRefs.current.get(openAt);
    target?.scrollIntoView({ block: "center" });
  }, [openAt]);

  if (items.length === 0) return null;

  return (
    <>
      <div className="flex items-center gap-1 py-1">
        {items.map((item) => {
          const failed = item.kind === "tool" && item.call.isError;
          const label =
            item.kind === "thinking"
              ? "Thinking"
              : `${item.call.name}${item.call.summary ? ` — ${item.call.summary}` : ""}`;

          return (
            <button
              aria-label={label}
              className={cn(
                "flex size-5 items-center justify-center rounded-full border transition-colors",
                failed
                  ? "border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/20"
                  : "border-border/60 bg-muted/40 text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
              key={item.id}
              onClick={() => setOpenAt(item.id)}
              title={label}
              type="button"
            >
              {item.kind === "thinking" ? (
                <BrainIcon className="size-3" />
              ) : (
                <WrenchIcon className="size-3" />
              )}
            </button>
          );
        })}
      </div>

      <Drawer
        modal={false}
        onOpenChange={(open) => !open && setOpenAt(null)}
        open={openAt !== null}
        swipeDirection="right"
      >
        <DrawerContent
          className="flex max-w-[90vw] flex-col overflow-hidden"
          style={
            { "--drawer-content-width": `${DRAWER_WIDTH}px` } as React.CSSProperties
          }
        >
          <DrawerHeader className="flex flex-row items-start justify-between gap-2 pb-3">
            <div className="min-w-0">
              <DrawerTitle>Steps</DrawerTitle>
              <DrawerDescription>{summariseSteps(items)}</DrawerDescription>
            </div>
            <DrawerClose className="shrink-0 rounded-sm p-1 opacity-70 hover:opacity-100">
              <XIcon className="size-4" />
            </DrawerClose>
          </DrawerHeader>

          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 pb-6">
            {items.map((item) => (
              <div
                className={cn(
                  "rounded border p-2 transition-colors",
                  openAt === item.id
                    ? "border-primary/40 bg-muted/30"
                    : "border-border/40",
                )}
                key={item.id}
                ref={(node) => {
                  detailRefs.current.set(item.id, node);
                }}
              >
                <StepDetail item={item} />
              </div>
            ))}
          </div>
        </DrawerContent>
      </Drawer>
    </>
  );
}
