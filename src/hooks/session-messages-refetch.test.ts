/**
 * A turn's entries reach the database only when the turn ends, so mid-turn the
 * server still returns the transcript from before it started. A focus refetch
 * then overwrites the optimistic user message with a list that does not contain
 * it, and the prompt vanishes from the conversation until the turn finishes.
 *
 * Driven through query-core's focusManager rather than asserting on the option,
 * so it fails if the library's focus semantics change under us.
 */
import assert from "node:assert/strict";
import { test } from "vitest";

import { QueryClient, QueryObserver, focusManager } from "@tanstack/query-core";

import {
  sessionMessagesQueryOptions,
  type SessionMessagesResult,
} from "./use-session-messages.ts";

const preTurn: SessionMessagesResult = {
  contextWindow: null,
  messages: [{ createdAt: "t0", id: "a", role: "user", text: "earlier" }],
  toolCalls: [],
};

const withOptimisticPrompt: SessionMessagesResult = {
  ...preTurn,
  messages: [
    ...preTurn.messages,
    { createdAt: "t1", id: "optimistic", role: "user", text: "the new prompt" },
  ],
};

const refocus = async () => {
  focusManager.setFocused(false);
  focusManager.setFocused(true);
  // A focus refetch is async; give it room to actually land, or the assertion
  // passes for the wrong reason.
  await new Promise((resolve) => setTimeout(resolve, 25));
};

/** Mounts the query the way the session view does, with an optimistic write. */
const mount = (turnActive: boolean) => {
  const client = new QueryClient();
  // QueryClientProvider does this in the app; without it the client never
  // subscribes to focusManager and no focus refetch can fire at all.
  client.mount();
  const options = {
    ...sessionMessagesQueryOptions("s1", turnActive),
    // Stands in for the server, which knows nothing of the in-flight turn.
    queryFn: async () => preTurn,
    // A turn outlives the 30s staleTime, so by the time the tab is refocused
    // the transcript is stale and eligible to refetch.
    staleTime: 0,
    // Isolates the focus path: a mount refetch would overwrite the optimistic
    // write on its own and prove nothing about focus.
    refetchOnMount: false as const,
  };
  // Written before the observer mounts, as the real optimistic update is: the
  // turn is already streaming by the time a refocus can happen.
  client.setQueryData(options.queryKey, withOptimisticPrompt);
  const observer = new QueryObserver<SessionMessagesResult>(client, options);
  const unsubscribe = observer.subscribe(() => {});
  return {
    client,
    options,
    unsubscribe: () => {
      unsubscribe();
      client.unmount();
    },
    texts: () =>
      client
        .getQueryData<SessionMessagesResult>(options.queryKey)!
        .messages.map((m) => m.text),
  };
};

test("a mid-turn refocus does not drop the optimistic prompt", async () => {
  const { unsubscribe, texts } = mount(true);

  await refocus();

  assert.deepEqual(texts(), ["earlier", "the new prompt"]);
  unsubscribe();
});

test("outside a turn, a refocus still refetches the transcript", async () => {
  const { unsubscribe, texts } = mount(false);

  await refocus();

  // The server list wins, which is what keeps a finished session current.
  assert.deepEqual(texts(), ["earlier"]);
  unsubscribe();
});

test("an explicit invalidate still refetches during a turn", async () => {
  const { client, options, unsubscribe, texts } = mount(true);

  // This is what onSettled does when the turn ends.
  await client.invalidateQueries({ queryKey: options.queryKey });

  assert.deepEqual(texts(), ["earlier"]);
  unsubscribe();
});
