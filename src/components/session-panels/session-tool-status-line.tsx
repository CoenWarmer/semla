"use client";

/**
 * A single line in the bottom bar: the name of the most recent tool call,
 * and the file it touched if any — "read src/foo.tsx", or just "bash" for a
 * call that read nothing. Replaces an earlier attempt at putting the full
 * `ReviewScrubber` pill here; this is meant to be a glance, not a second
 * navigation surface, so it only ever shows the latest call.
 *
 * The reveal is a fake stream: nothing here is actually arriving token by
 * token — a tool call is one discrete event — so the typewriter effect is
 * simulated with a timer rather than real incremental text. It restarts
 * whenever the label changes, including partway through animating the
 * previous one; a call that lands mid-reveal is a real event and should cut
 * the old text short rather than queue behind it.
 *
 * Sources its own data the way every other bottom-bar panel does —
 * `useParams()`, since the bar is a layout-level sibling of the session page
 * (see layout.tsx) rather than a descendant of it — and merges the live
 * stream with the persisted timeline the same way `ReviewPanel` does, so the
 * line still names the session's last tool call once a turn ends and the
 * live caches are cleared (see session-live-state.ts's own doc comment on
 * why the persisted fetch does not race that clear).
 */

import { useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";

import { useFileAccess } from "@/hooks/use-file-access";
import { toolCallStepsFromLive } from "@/lib/pi/file-access/access-live-merge";
import type { ToolCallStep } from "@/lib/pi/file-access/access-types";
import {
  useSessionLiveAccesses,
  useSessionLiveToolCalls,
} from "@/lib/session/session-live-state";

/** Milliseconds per revealed character — fast enough to read as "live", slow enough to actually see happen. */
const REVEAL_MS = 18;

/** The tool's name, plus the file it touched if it touched exactly one worth naming. */
function labelFor(call: ToolCallStep): string {
  const access = call.accesses[0];
  return access ? `${call.name} ${access.path}` : call.name;
}

export function SessionToolStatusLine() {
  const { id } = useParams<{ id?: string }>();
  const sessionId = id;
  const leafId = useSearchParams().get("leaf");

  const fileAccess = useFileAccess(sessionId ?? "", leafId, !!sessionId);
  const liveAccesses = useSessionLiveAccesses(sessionId ?? "").data;
  const liveToolCalls = useSessionLiveToolCalls(sessionId ?? "").data;

  const calls = useMemo(
    () => [
      ...(fileAccess.data?.calls ?? []),
      ...toolCallStepsFromLive(liveToolCalls ?? [], liveAccesses ?? []),
    ],
    [fileAccess.data?.calls, liveAccesses, liveToolCalls],
  );

  const label = useMemo(() => {
    const latest = calls[calls.length - 1];
    return latest ? labelFor(latest) : "";
  }, [calls]);

  /**
   * How much of `label` is revealed so far. Reset to 0 and re-animated up
   * whenever `label` itself changes — this is the "fake streaming": there
   * is no real partial text to receive, so the timer manufactures it.
   */
  const [shown, setShown] = useState("");

  useEffect(() => {
    if (label === "") return;

    let revealed = 0;
    // Restarting the reveal for a new label, not resuming a paused one — a
    // direct set here (rather than only inside the timer below) is what
    // makes a call that lands mid-animation cut the previous text short
    // instead of finishing it first.
    // oxlint-disable-next-line react/set-state-in-effect
    setShown("");

    const timer = setInterval(() => {
      revealed += 1;
      setShown(label.slice(0, revealed));
      if (revealed >= label.length) clearInterval(timer);
    }, REVEAL_MS);

    return () => clearInterval(timer);
  }, [label]);

  if (!sessionId || label === "") return null;

  return (
    <div className="flex min-w-0 flex-1 items-center gap-1 text-muted-foreground">
      <span className="truncate font-mono">{shown}</span>
      {shown.length < label.length && (
        <span aria-hidden className="shrink-0 animate-pulse">
          ▌
        </span>
      )}
    </div>
  );
}
