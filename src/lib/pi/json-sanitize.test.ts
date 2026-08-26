import assert from "node:assert/strict";
import { test } from "vitest";

import { sanitizeText, toAsciiJson, toJson } from "./json-sanitize.ts";

// The exact payload that broke session 8c69a65e: pi-dynamic-workflows truncates
// an agent's resultPreview to 80 UTF-16 code units, which cut this emoji in
// half and left an unpaired high surrogate. PostgREST rejected the whole
// request body with "Empty or invalid json", and because parent_entry_id is a
// self-referencing FK, every later entry of that turn was dropped too —
// including the assistant's finished audit.
const TRUNCATED_EMOJI = "## 1. Duplicated Logic \ud83d…";

test("strips an unpaired high surrogate left by truncation", () => {
  assert.equal(sanitizeText(TRUNCATED_EMOJI), "## 1. Duplicated Logic \ufffd…");
});

test("strips an unpaired low surrogate", () => {
  assert.equal(sanitizeText("x\udd34y"), "x\ufffdy");
});

test("leaves a complete surrogate pair intact", () => {
  const intact = "all clear \ud83d\udd34";
  assert.equal(sanitizeText(intact), intact);
  assert.equal(JSON.parse(JSON.stringify(toJson({ intact }))).intact, intact);
});

test("strips NUL, which Postgres cannot store in text or jsonb", () => {
  assert.equal(sanitizeText("a\u0000b"), "ab");
});

test("leaves ordinary text untouched", () => {
  const text = "héllo — wörld\ttabbed\nnewline";
  assert.equal(sanitizeText(text), text);
});

test("toJson emits a body with no unpaired surrogate escapes", () => {
  const payload = { entry: { preview: TRUNCATED_EMOJI, nested: [TRUNCATED_EMOJI] } };

  // An unpaired \udXXX escape in the serialised body is what PostgREST rejects.
  const unpaired = /\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f])/gi;
  assert.match(JSON.stringify(payload), unpaired);
  assert.doesNotMatch(JSON.stringify(toJson(payload)), unpaired);
});

test("toJson preserves structure and non-string types", () => {
  const value = { n: 1, t: true, nil: null, list: [1, "two"], deep: { s: "x" } };
  assert.deepEqual(toJson(value), value);
});

test("toAsciiJson degrades characters but keeps the shape", () => {
  const value = { label: "héllo 🔴", id: 7, ok: false };
  assert.deepEqual(toAsciiJson(value), { label: "h?llo ??", id: 7, ok: false });
});
