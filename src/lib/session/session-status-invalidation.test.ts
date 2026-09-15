/**
 * The per-session status key sits under the list's prefix on purpose, so that
 * a create or a project change refreshes both with one invalidation.
 *
 * Deleting a session is the one case where that is wrong. The session is gone,
 * its own query can only be answered 404, and the default single retry makes
 * that take about a second — awaited, in the middle of navigating away from
 * the page being deleted. A HAR capture showed exactly that: the 404, a retry
 * a second later, and only then the rest of the delete.
 *
 * Driven through query-core rather than asserting on the options, so it fails
 * if the library's matching semantics change under us.
 */
import assert from "node:assert/strict";
import { test } from "vitest";

import { QueryClient } from "@tanstack/query-core";

import { SESSION_STATUS_KEY, sessionStatusKey } from "./session-status.ts";

const seeded = () => {
  const client = new QueryClient();
  client.setQueryData(SESSION_STATUS_KEY, []);
  client.setQueryData(sessionStatusKey("doomed"), {
    isRunning: false,
    projects: [],
  });
  return client;
};

const invalidated = (client: QueryClient, key: readonly unknown[]) =>
  client.getQueryState(key)?.isInvalidated ?? false;

test("the list prefix reaches every session's own status query", async () => {
  const client = seeded();

  await client.invalidateQueries({ queryKey: SESSION_STATUS_KEY });

  // Not a bug in itself — this is what makes one invalidation refresh both
  // after a create or a project change. It is only wrong for a delete.
  assert.equal(invalidated(client, SESSION_STATUS_KEY), true);
  assert.equal(invalidated(client, sessionStatusKey("doomed")), true);
});

test("exact keeps a deletion from refetching the session it just deleted", async () => {
  const client = seeded();

  await client.invalidateQueries({ queryKey: SESSION_STATUS_KEY, exact: true });

  assert.equal(invalidated(client, SESSION_STATUS_KEY), true);
  assert.equal(invalidated(client, sessionStatusKey("doomed")), false);
});

test("removing the session's query leaves nothing to answer 404", () => {
  const client = seeded();

  client.removeQueries({ queryKey: sessionStatusKey("doomed") });

  assert.equal(client.getQueryData(sessionStatusKey("doomed")), undefined);
  // The list survives: it is a different entry, and the sidebar still needs it.
  assert.deepEqual(client.getQueryData(SESSION_STATUS_KEY), []);
});
