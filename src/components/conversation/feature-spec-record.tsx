"use client";

/**
 * What the user submitted through `capture_feature_spec`'s form, as its own
 * row in the transcript.
 *
 * Same reasoning as AskUserRecord: this is a decision the reader made, not
 * work the agent did on its own, and the fields are not recorded anywhere
 * else — the tool's arguments are dropped on persistence — so it renders as
 * a message aligned with the user's side rather than as an unlabelled step.
 */

import { ClipboardListIcon } from "lucide-react";

import type { FeatureSpecField } from "@/lib/tool-records/feature-spec-record";
import { cn } from "@/lib/utils";

export function FeatureSpecRecord({
  cancelled,
  fields,
  raw,
}: {
  cancelled: boolean;
  fields: FeatureSpecField[];
  raw?: string;
}) {
  return (
    <div className="ml-auto flex w-full max-w-[95%] flex-col gap-2">
      <div
        className={cn(
          "ml-auto flex w-fit min-w-0 max-w-full flex-col gap-2 rounded-lg border px-4 py-3 text-sm",
          cancelled
            ? "border-border/60 bg-muted/30"
            : "border-border/60 bg-secondary/60",
        )}
      >
        <div className="flex items-center gap-1.5 text-muted-foreground text-xs">
          <ClipboardListIcon className="size-3.5 shrink-0" />
          <span>{cancelled ? "Feature spec cancelled" : "Feature spec captured"}</span>
        </div>

        {fields.length > 0 ? (
          <dl className="flex flex-col gap-2">
            {fields.map((field, index) => (
              <div className="flex flex-col gap-0.5" key={`${index}:${field.label}`}>
                <dt className="text-muted-foreground text-xs leading-snug">
                  {field.label}
                </dt>
                <dd className="whitespace-pre-wrap font-medium leading-snug">
                  {field.value || "—"}
                </dd>
              </div>
            ))}
          </dl>
        ) : (
          raw && (
            <p className="whitespace-pre-wrap text-muted-foreground text-xs leading-relaxed">
              {raw}
            </p>
          )
        )}
      </div>
    </div>
  );
}
