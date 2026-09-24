/**
 * Regression test for the "ask_user cancel eats the new prompt" bug: an
 * operator ignores the agent's `ask_user` options and types a fresh prompt
 * instead. The cancel is correct — the tool rejects and the server aborts
 * the old turn — but the new prompt visibly disappeared from the
 * conversation until the page was reloaded.
 *
 * Root cause: the superseded (`ask_user`) call's own `mutationFn` does not
 * throw until its SSE stream actually closes, and that stream stays open
 * server-side until the prompt route's `finally` chain (residual capture,
 * artifact drain) finishes — which can be *after* the newer prompt's own
 * mutation has already settled and rendered its reply. The old call's
 * `onError` then restored a `previousMessages` snapshot taken before it
 * ever ran, overwriting the newer, correct transcript with no further
 * refetch to fix it.
 *
 * `isCurrentMutation` is the guard `onError`/`onSettled` now check before
 * touching the shared message cache — pinned here without a DOM, the same
 * way `reconnect-if-still-running.test.ts` pins its sibling decision.
 */
import assert from "node:assert/strict";
import { test } from "vitest";

import { isCurrentMutation } from "./use-prompt-mutation.ts";

test("a call whose epoch matches the latest onMutate is current", () => {
  assert.equal(isCurrentMutation({ epoch: 3 }, 3), true);
});

test("a superseded call's stale epoch is not current", () => {
  // The scenario: onMutate #1 (ask_user turn) captured epoch 1, then
  // onMutate #2 (the operator's new prompt) bumped the counter to 2 before
  // #1's stream ever closed.
  assert.equal(isCurrentMutation({ epoch: 1 }, 2), false);
});

test("no context (mutationFn failed before onMutate returned) is treated as current", () => {
  // There is no snapshot to restore and no epoch to compare — dropping a
  // real failure here would be worse than the rare false positive.
  assert.equal(isCurrentMutation(undefined, 5), true);
});
