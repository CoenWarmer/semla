"use client";

/**
 * The call graph of the function the operator asked about, over the editor.
 *
 * Over rather than instead of: the editor's model holds unsaved edits, and
 * unmounting it to show a diagram would throw them away.
 *
 * The map is built by calling the type checker directly rather than by asking
 * the agent to run its `code_map` tool. Same machinery, same limits — and the
 * panel reports those limits for the same reason the tool's own does: a call
 * graph is always partial, bounded by depth, by the node cap and by what a
 * checker can resolve, and a diagram that draws only the confident part looks
 * complete when it is not. `CodeMapPanel` states them in its header.
 */

import { XIcon } from "lucide-react";

import { CodeMapPanel } from "@/components/code-map-panel";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type { CodeMapAtLine } from "@/hooks/use-review";

export function ReviewCodeMap({
  onClose,
  pending,
  result,
}: {
  onClose: () => void;
  pending: boolean;
  result: CodeMapAtLine | null;
}) {
  return (
    <div className="absolute inset-0 z-10 flex flex-col bg-background">
      <header className="flex shrink-0 items-center gap-2 border-b px-3 py-1.5">
        <h3 className="text-xs font-medium">
          {result?.symbol ? (
            <>
              Call graph ·{" "}
              <span className="font-mono">{result.symbol.symbol}</span>
            </>
          ) : (
            "Call graph"
          )}
        </h3>

        <Button
          aria-label="Close the call graph"
          className="ml-auto size-6"
          onClick={onClose}
          size="icon"
          variant="ghost"
        >
          <XIcon className="size-3.5" />
        </Button>
      </header>

      <div className="min-h-0 flex-1">
        {pending ? (
          <div className="flex h-full items-center justify-center">
            <Spinner />
          </div>
        ) : result?.error ? (
          // The checker's own message, which names what it could not do — a
          // file outside the tsconfig, or a declaration shape it did not find.
          <div className="flex h-full items-center justify-center px-8 text-center text-sm text-muted-foreground">
            <p>{result.error}</p>
          </div>
        ) : (
          <CodeMapPanel map={result?.map ?? undefined} />
        )}
      </div>
    </div>
  );
}
