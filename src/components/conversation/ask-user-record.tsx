"use client";

/**
 * What the reader answered when the agent asked, as its own row in the
 * transcript.
 *
 * This used to be one unlabelled dot in the steps strip, which is the wrong
 * weight for it: the rest of the strip is work the agent did on its own, while
 * this is a decision the reader made, and the turns after it only make sense
 * in the light of it. So it reads as a message rather than as a step — aligned
 * with the user's side, since that is whose words the answers are.
 *
 * Questions are shown alongside the answers deliberately. An answer on its own
 * ("card", "yes") is unreadable a week later, and the question is not anywhere
 * else in the transcript — `ask_user`'s arguments are dropped on persistence.
 */

import { MessageCircleQuestionMarkIcon } from "lucide-react";

import type { AskUserPair } from "@/lib/ask-user-record";
import { cn } from "@/lib/utils";

export function AskUserRecord({
  cancelled,
  pairs,
  raw,
}: {
  cancelled: boolean;
  pairs: AskUserPair[];
  raw?: string;
}) {
  const count = pairs.length;

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
          <MessageCircleQuestionMarkIcon className="size-3.5 shrink-0" />
          <span>
            {cancelled
              ? "Question cancelled"
              : count === 0
                ? "Question asked"
                : count === 1
                  ? "Answered 1 question"
                  : `Answered ${count} questions`}
          </span>
        </div>

        {count > 0 ? (
          <dl className="flex flex-col gap-2">
            {pairs.map((pair, index) => (
              <div className="flex flex-col gap-0.5" key={`${index}:${pair.question}`}>
                <dt className="text-muted-foreground text-xs leading-snug">
                  {pair.question}
                </dt>
                <dd className="whitespace-pre-wrap font-medium leading-snug">
                  {pair.answer || "—"}
                </dd>
              </div>
            ))}
          </dl>
        ) : (
          raw && (
            // Not in the expected shape — a cancellation, or a wording change
            // in the tool. Better verbatim than silently blank.
            <p className="whitespace-pre-wrap text-muted-foreground text-xs leading-relaxed">
              {raw}
            </p>
          )
        )}
      </div>
    </div>
  );
}
