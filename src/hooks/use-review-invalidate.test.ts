/**
 * Regression test for the review commit bar staying hidden (or stuck
 * visible) after staging or committing a hunk.
 *
 * Root cause (established in the completed investigation): `useStageHunks`
 * and `useCommitReview` call `invalidateAfterWrite` from their
 * `onSuccess`, but the old `invalidateAfterWrite` started each
 * `queryClient.invalidateQueries` call with `void` and returned nothing.
 * `invalidateQueries` only *marks* a query stale and kicks off a refetch —
 * it does not wait for that refetch. Fire-and-forgetting it means the
 * mutation's own success resolves before the review query's `staged` count
 * (the thing `stagedCount(activeProject) > 0` reads to decide whether the
 * commit bar renders) has actually been refetched.
 *
 * The fix makes `invalidateAfterWrite` return the `Promise.all(...)` of the
 * three `invalidateQueries` calls, and every call site now returns (or
 * awaits) that promise from `onSuccess` instead of discarding it. This test
 * pins that behaviour directly against `invalidateAfterWrite` and a real
 * `QueryClient` — no DOM is available in this test setup (see
 * reconnect-if-still-running.test.ts), so the review-query refetch is
 * driven through the query client itself rather than by rendering
 * `useStageHunks`.
 */
import assert from "node:assert/strict";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { test } from "vitest";

import { sessionStatusKey } from "@/lib/session/session-status";

import {
  invalidateAfterWrite,
  reviewQueryKey,
} from "./use-review.ts";

test("invalidateAfterWrite resolves only after the review query has refetched", async () => {
  const sessionId = "session-1";
  const queryClient = new QueryClient();

  // Seed the review query the way `useReview(sessionId)` would have left
  // it: one staged file, which is what makes `stagedCount(activeProject) >
  // 0` true and the commit bar visible.
  let staged = 1;
  queryClient.setQueryDefaults(reviewQueryKey(sessionId), {
    queryFn: () => Promise.resolve({ staged }),
    staleTime: 0,
  });
  await queryClient.fetchQuery({ queryKey: reviewQueryKey(sessionId) });

  // `invalidateQueries` only refetches *active* queries by default — a
  // query fetched once with `fetchQuery` and never observed is "inactive"
  // and would silently stay stale. `useReview(sessionId)` subscribes an
  // observer via `useQuery`, which is what makes the real review query
  // active; a bare `QueryObserver` reproduces that here.
  const observer = new QueryObserver(queryClient, {
    queryKey: reviewQueryKey(sessionId),
  });
  const unsubscribe = observer.subscribe(() => {});

  // Simulate the write that a stage/commit action just performed: the
  // server-side state moved (no more staged files) before the client is
  // told to invalidate.
  staged = 0;

  await invalidateAfterWrite(queryClient, sessionId);

  const refreshed = queryClient.getQueryData(reviewQueryKey(sessionId)) as {
    staged: number;
  };
  unsubscribe();

  assert.equal(
    refreshed.staged,
    0,
    "invalidateAfterWrite must not resolve until the review query it " +
      "invalidated has refetched — otherwise a caller that reacts to " +
      "mutation success (like the commit bar's visibility check) can " +
      "still see the pre-write staged count",
  );
});

test("invalidateAfterWrite also refetches the session-status query the summary card reads", async () => {
  // Regression: committing from the review panel correctly dropped the
  // committed files from the summary card's "uncommitted diff" row (that
  // comes from the review query above), but never showed the new commit —
  // the commit row comes from `SingleSessionStatus.artifacts`, under
  // `sessionStatusKey`, which `invalidateAfterWrite` did not invalidate.
  const sessionId = "session-2";
  const queryClient = new QueryClient();

  let commits = 0;
  queryClient.setQueryDefaults(sessionStatusKey(sessionId), {
    queryFn: () => Promise.resolve({ commits }),
    staleTime: 0,
  });
  await queryClient.fetchQuery({ queryKey: sessionStatusKey(sessionId) });

  const observer = new QueryObserver(queryClient, {
    queryKey: sessionStatusKey(sessionId),
  });
  const unsubscribe = observer.subscribe(() => {});

  // The commit route just ran: the session now has one more commit than the
  // status query was last told about.
  commits = 1;

  await invalidateAfterWrite(queryClient, sessionId);

  const refreshed = queryClient.getQueryData(sessionStatusKey(sessionId)) as {
    commits: number;
  };
  unsubscribe();

  assert.equal(
    refreshed.commits,
    1,
    "invalidateAfterWrite must also invalidate sessionStatusKey, or the " +
      "summary card keeps showing the pre-commit artifact snapshot until " +
      "its own poll interval catches up",
  );
});
