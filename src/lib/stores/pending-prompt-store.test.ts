import assert from "node:assert/strict";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  createPendingPromptStore,
  type PendingPrompt,
} from "./pending-prompt-store.ts";

const SESSION_A = "11111111-1111-4111-8111-111111111111";
const SESSION_B = "22222222-2222-4222-8222-222222222222";

const prompt = (text: string): PendingPrompt => ({
  model: { modelId: "claude-sonnet-5", provider: "openrouter" },
  text,
  tools: ["read", "bash"],
});

test("consume returns the prompt stashed for that session", () => {
  const store = createPendingPromptStore();
  store.set(SESSION_A, prompt("hello"));

  assert.deepEqual(store.consume(SESSION_A), prompt("hello"));
});

test("consume clears the slot, so the prompt is submitted once", () => {
  const store = createPendingPromptStore();
  store.set(SESSION_A, prompt("hello"));

  assert.equal(store.consume(SESSION_A)?.text, "hello");
  assert.equal(
    store.consume(SESSION_A),
    null,
    "a second read must not replay the prompt",
  );
});

test("consume ignores a prompt stashed for a different session", () => {
  const store = createPendingPromptStore();
  store.set(SESSION_A, prompt("for A"));

  assert.equal(store.consume(SESSION_B), null);
});

test("a prompt meant for another session is left intact for its owner", () => {
  const store = createPendingPromptStore();
  store.set(SESSION_A, prompt("for A"));

  store.consume(SESSION_B);

  assert.equal(
    store.consume(SESSION_A)?.text,
    "for A",
    "a mismatched read must not consume the slot",
  );
});

test("consume returns null when nothing was stashed", () => {
  assert.equal(createPendingPromptStore().consume(SESSION_A), null);
});

test("set replaces an unconsumed prompt", () => {
  const store = createPendingPromptStore();
  store.set(SESSION_A, prompt("first"));
  store.set(SESSION_B, prompt("second"));

  assert.equal(store.consume(SESSION_A), null);
  assert.equal(store.consume(SESSION_B)?.text, "second");
});

test("the goal rides along with the prompt", () => {
  const store = createPendingPromptStore();
  store.set(SESSION_A, { ...prompt("hello"), goal: "ship it" });

  assert.equal(store.consume(SESSION_A)?.goal, "ship it");
});

/**
 * A session created by /sessions/new does not exist yet — the id is minted on
 * the client and navigated to without waiting — so what the arriving page needs
 * in order to create it travels with the prompt.
 */
test("what the session needs to be created rides along with the prompt", () => {
  const store = createPendingPromptStore();

  store.set(SESSION_A, {
    ...prompt("hello"),
    create: { project: "semla", title: "semla" },
  });

  assert.deepEqual(store.consume(SESSION_A)?.create, {
    project: "semla",
    title: "semla",
  });
});

// An existing session's prompt carries no creation payload.
test("an existing session's prompt carries no create payload", () => {
  const store = createPendingPromptStore();
  store.set(SESSION_A, prompt("hello"));

  assert.equal(store.consume(SESSION_A)?.create, undefined);
});

/**
 * The slot used to live only in React state, and the prompt it holds is the
 * only submit carrying the `create` payload the prompt route needs. A hard
 * load between minting the session id and submitting therefore left a session
 * that was never created and could not be, answering 404 to every prompt typed
 * into it. Diagnosed from a real one: session 52266fad had no file on disk and
 * no debug artifact, and the route answered "Session not found." to a probe.
 */
describe("surviving a reload", () => {
  const fakeStorage = () => {
    const map = new Map<string, string>();
    return {
      getItem: (k: string) => map.get(k) ?? null,
      removeItem: (k: string) => void map.delete(k),
      setItem: (k: string, v: string) => void map.set(k, v),
      get size() {
        return map.size;
      },
    };
  };

  const withStorage = (storage: unknown) => {
    vi.stubGlobal("window", { sessionStorage: storage });
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const prompt = (text = "hello"): PendingPrompt => ({
    create: { project: null, title: "t" },
    model: { modelId: "m", provider: "p" } as PendingPrompt["model"],
    text,
    tools: [],
  });

  test("hands the prompt to a store built after a reload", () => {
    const storage = fakeStorage();
    withStorage(storage);

    createPendingPromptStore().set("s1", prompt());
    // A reload discards the React tree, so the page arrives with a new store.
    const afterReload = createPendingPromptStore();

    expect(afterReload.consume("s1")?.text).toBe("hello");
  });

  test("carries the create payload, which is the whole point", () => {
    withStorage(fakeStorage());

    createPendingPromptStore().set("s1", prompt());

    // Without this the session is never created and the page is a dead end.
    expect(createPendingPromptStore().consume("s1")?.create).toEqual({
      project: null,
      title: "t",
    });
  });

  test("clears storage once consumed, so the prompt is submitted once", () => {
    const storage = fakeStorage();
    withStorage(storage);

    const store = createPendingPromptStore();
    store.set("s1", prompt());
    store.consume("s1");

    expect(storage.size).toBe(0);
    expect(createPendingPromptStore().consume("s1")).toBeNull();
  });

  test("never replays into another session", () => {
    withStorage(fakeStorage());
    createPendingPromptStore().set("s1", prompt());

    expect(createPendingPromptStore().consume("s2")).toBeNull();
  });

  test("ignores a stored value that is not a prompt", () => {
    const storage = fakeStorage();
    storage.setItem("semla.pending-prompt", '{"sessionId":"s1"}');
    withStorage(storage);

    // Anything could have written that key.
    expect(createPendingPromptStore().consume("s1")).toBeNull();
  });

  test("ignores unparseable storage", () => {
    const storage = fakeStorage();
    storage.setItem("semla.pending-prompt", "not json");
    withStorage(storage);

    expect(createPendingPromptStore().consume("s1")).toBeNull();
  });

  test("still works when storage throws", () => {
    withStorage({
      getItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    });

    // Private mode, or a full quota: the in-memory slot must still carry the
    // soft navigation this is mainly for.
    const store = createPendingPromptStore();
    store.set("s1", prompt());
    expect(store.consume("s1")?.text).toBe("hello");
  });

  test("works with no window at all", () => {
    vi.stubGlobal("window", undefined);

    const store = createPendingPromptStore();
    store.set("s1", prompt());
    expect(store.consume("s1")?.text).toBe("hello");
  });
});
