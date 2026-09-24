import { useCallback, useState } from "react";

import { patchSession } from "@/lib/session/patch-session";

/**
 * The session's title and goal, and their saves.
 *
 * Both are optimistic and both roll back when the save fails. The rollback
 * only applies while the value on screen is still the one that failed: a
 * later edit that already replaced it is newer than the rollback and wins.
 */
export function useSessionHeader({
  initialGoal,
  serverTitle,
  sessionId,
  title,
}: {
  initialGoal: string | null | undefined;
  /** The title the stream derived for a session created by its first prompt. */
  serverTitle: string | null | undefined;
  sessionId: string;
  /** The server render's title — null for a session created by its first prompt. */
  title: string | null;
}) {
  /**
   * `title` is the server's render, which for a session created by its own
   * first prompt is null — the title is derived from that prompt while the
   * turn runs, and arrives over the stream. Rendering it from here is what
   * replaced a `router.refresh()` after the turn: a full root-layout
   * re-render, measured at ~4s, to propagate one string.
   */
  const [titleOverride, setTitleOverride] = useState<string | null>(null);
  const shownTitle = titleOverride ?? serverTitle ?? title;
  const [goal, setGoal] = useState<string | null>(initialGoal ?? null);

  const saveGoal = useCallback(
    async (next: string | null) => {
      const previous = goal;
      setGoal(next);
      await patchSession(sessionId, { goal: next ?? "" }).catch((error: unknown) => {
        console.warn("[session] goal save failed:", error);
        setGoal((current) => (current === next ? previous : current));
      });
    },
    [goal, sessionId],
  );

  /**
   * The PATCH route ignores a blank title (see route.ts), so there is no
   * `null` case here the way there is for `saveGoal` — a title is either
   * replaced with a non-empty string or left alone.
   */
  const saveTitle = useCallback(
    async (next: string) => {
      const previous = titleOverride;
      setTitleOverride(next);
      await patchSession(sessionId, { title: next }).catch((error: unknown) => {
        console.warn("[session] title save failed:", error);
        setTitleOverride((current) => (current === next ? previous : current));
      });
    },
    [sessionId, titleOverride],
  );

  return { goal, saveGoal, saveTitle, shownTitle };
}
