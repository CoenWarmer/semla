import assert from "node:assert/strict";
import { test } from "vitest";

import { MutationObserver, QueryClient } from "@tanstack/query-core";

/**
 * Pins the library behaviour that forces the first prompt of a session to be
 * submitted from a deferred callback rather than inline in a mount effect
 * (see the auto-submit effect in client-session-component.tsx).
 *
 * MutationObserver attaches itself to a mutation in exactly one place —
 * inside mutate() — and detaches in onUnsubscribe(). There is no onSubscribe,
 * so it never re-attaches. React StrictMode does subscribe → unsubscribe →
 * subscribe on mount, which means a mutation started during that commit is
 * orphaned: it runs to completion and dispatches "success" to an empty
 * observer list, leaving useMutation's result stuck on "pending" forever.
 */

const deferred = () => {
  let resolve!: (value: string) => void;
  const promise = new Promise<string>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

/** Let queued microtasks and the notify scheduler drain. */
const settle = () => new Promise((r) => setTimeout(r, 0));

test("a mutation started during the mount commit is orphaned by StrictMode", async () => {
  const client = new QueryClient();
  const gate = deferred();
  const observer = new MutationObserver(client, {
    mutationFn: () => gate.promise,
  });

  // React subscribes on mount.
  let unsubscribe = observer.subscribe(() => {});

  // The broken ordering: the mutation starts inside the mount commit.
  const running = observer.mutate(undefined).catch(() => {});

  // StrictMode then tears the subscription down and sets it back up.
  unsubscribe();
  unsubscribe = observer.subscribe(() => {});

  gate.resolve("done");
  await running;
  await settle();

  assert.equal(
    client.getMutationCache().getAll()[0]?.state.status,
    "success",
    "the mutation itself does finish",
  );
  assert.equal(
    observer.getCurrentResult().status,
    "pending",
    "regression guard: if this now reads 'success', query-core re-attaches on " +
      "subscribe and the deferred submit in client-session-component.tsx is " +
      "no longer needed",
  );
  assert.equal(observer.getCurrentResult().isPending, true);

  unsubscribe();
});

test("a mutation started after the mount commit settles normally", async () => {
  const client = new QueryClient();
  const gate = deferred();
  const observer = new MutationObserver(client, {
    mutationFn: () => gate.promise,
  });

  // StrictMode's subscribe → unsubscribe → subscribe completes first...
  let unsubscribe = observer.subscribe(() => {});
  unsubscribe();
  unsubscribe = observer.subscribe(() => {});

  // ...and only then does the mutation start, which is what deferring achieves.
  const running = observer.mutate(undefined).catch(() => {});

  gate.resolve("done");
  await running;
  await settle();

  assert.equal(observer.getCurrentResult().status, "success");
  assert.equal(
    observer.getCurrentResult().isPending,
    false,
    "this is the spinner clearing",
  );

  unsubscribe();
});
