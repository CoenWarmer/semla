/**
 * Regression test for GitHub #13: the trace panel did not live-update when a
 * background workflow started a new phase or spawned a new agent.
 *
 * Root cause (established empirically, see the issue): the panel reads the
 * prompt POST's own response body stream, which is not reopenable and ends
 * the instant this turn's model loop goes idle — even when the server is
 * about to carry on (a background continuation). `onSettled` never handed
 * the client back onto the live `/stream` reconnect path, so a tab whose
 * turn just ended was orphaned with no listener, while only a freshly
 * mounted tab (which reconnects on mount when `initialIsRunning`) kept
 * seeing updates.
 *
 * `reconnectIfStillRunning` is the fix's decision, pulled out of
 * `onSettled` so it can be pinned without rendering the hook — this repo's
 * test setup has no DOM (no jsdom, no @testing-library/react), and
 * `use-prompt-mutation.ts`'s own hook body needs one to run at all.
 */
import assert from "node:assert/strict";
import { test } from "vitest";

import { reconnectIfStillRunning } from "./use-prompt-mutation.ts";

test("a still-running session triggers a stream reconnect on settle", () => {
  let calls = 0;
  reconnectIfStillRunning(true, () => {
    calls += 1;
  });

  assert.equal(
    calls,
    1,
    "onSettled must reconnect when the server is still running — this is " +
      "the case a background workflow continuation left orphaned",
  );
});

test("a finished session does not reconnect on settle", () => {
  let calls = 0;
  reconnectIfStillRunning(false, () => {
    calls += 1;
  });

  assert.equal(
    calls,
    0,
    "a turn that actually ended must not open a stream nobody needs",
  );
});
