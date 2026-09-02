/**
 * Tag every wiki page a turn wrote with the repos that turn worked in.
 *
 * Fire-and-forget by design: the wiki is a side product of the turn, so a slow
 * or failing stamp must not hold the SSE stream open or fail the prompt.
 *
 * Called by both the prompt turn and the background continuation — background
 * wiki ingest commits its pages after the prompt turn's own sweep has already
 * run, so the continuation needs a sweep of its own.
 */

import { sessionLog, sessionWarn } from "@/lib/pi/session-log";
import { stampSessionWikiPages } from "@/lib/pi/wiki-repo-stamp";

export const stampWikiRepo = (
  semlaSessionId: string,
  slugs: readonly string[],
  since: number,
): void => {
  void stampSessionWikiPages({ slugs, since })
    .then((stamped) => {
      if (stamped.length > 0) {
        sessionLog(semlaSessionId, "wiki repo stamped", {
          pages: stamped.length,
        });
      }
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      sessionWarn(semlaSessionId, `wiki repo stamp failed: ${message}`);
    });
};
