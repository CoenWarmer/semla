import assert from "node:assert/strict";
import { test } from "vitest";

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
