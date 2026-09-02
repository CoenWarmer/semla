/**
 * Which extensions a session loads depends on whether it has a project at all
 * — see `requiresProjectAnchor` — so attaching the first one gains it the
 * code-intelligence tools. The prompt bar reads that list from a cached query
 * keyed by session, and attaching a project used to leave it untouched: the
 * pulldown went on offering the shorter list until a reload.
 *
 * Driven through query-core rather than asserting on the options object, so it
 * fails if the library's key matching changes under us.
 */
import assert from "node:assert/strict";
import { test } from "vitest";

import { QueryClient } from "@tanstack/query-core";

import { projectChangeInvalidations } from "./use-session-projects.ts";
import { toolsQueryKey } from "./use-tools.ts";

const SESSION = "s1";

const seeded = () => {
  const client = new QueryClient();
  client.setQueryData(toolsQueryKey(SESSION), { extensionTools: [] });
  client.setQueryData(toolsQueryKey("other-session"), { extensionTools: [] });
  client.setQueryData(toolsQueryKey(), { extensionTools: [] });
  client.setQueryData(["session-files", SESSION], []);
  client.setQueryData(["git-status"], {});
  client.setQueryData(["session-status"], []);
  return client;
};

const invalidate = async (client: QueryClient) => {
  for (const queryKey of projectChangeInvalidations(SESSION)) {
    await client.invalidateQueries({ queryKey });
  }
};

const invalidated = (client: QueryClient, key: readonly unknown[]) =>
  client.getQueryState(key)?.isInvalidated ?? false;

test("a project change refreshes the session's tool list", async () => {
  const client = seeded();

  await invalidate(client);

  assert.equal(invalidated(client, toolsQueryKey(SESSION)), true);
});

test("it still refreshes everything else that reads the links", async () => {
  const client = seeded();

  await invalidate(client);

  for (const key of [
    ["session-status"],
    ["session-files", SESSION],
    ["git-status"],
  ]) {
    assert.equal(invalidated(client, key), true, `${key.join("/")} not invalidated`);
  }
});

// One session gaining a project says nothing about another's tools.
test("it leaves another session's tool list alone", async () => {
  const client = seeded();

  await invalidate(client);

  assert.equal(invalidated(client, toolsQueryKey("other-session")), false);
});

/**
 * /sessions/new has no session and is answered with the full set, which is
 * correct there because the first prompt runs anchored. It must not be
 * invalidated by another session's project change.
 */
test("it leaves the session-less tool list alone", async () => {
  const client = seeded();

  await invalidate(client);

  assert.equal(invalidated(client, toolsQueryKey()), false);
});
