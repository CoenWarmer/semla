/**
 * The digest's three load-bearing properties: content changes move it, visit
 * order does not, and an absent file is not the same as a file that was never
 * looked for. The last one is why a missing input is folded as a marker rather
 * than skipped — otherwise deleting vitest.config.mts is invisible.
 */

import { describe, expect, it } from "vitest";

import { computeInputsDigest } from "./digest";

const inputs = [
  { content: '{"scripts":{}}', label: "package.json" },
  { content: null, label: "playwright.config.ts" },
  { content: "{}", label: "mcp.json" },
];

describe("computeInputsDigest", () => {
  it("moves when any one input's content changes", () => {
    const before = computeInputsDigest(inputs).digest;
    const after = computeInputsDigest([
      { content: '{"scripts":{"test":"vitest run"}}', label: "package.json" },
      ...inputs.slice(1),
    ]).digest;

    expect(after).not.toBe(before);
  });

  it("does not move when the inputs are visited in a different order", () => {
    const forward = computeInputsDigest(inputs).digest;
    const reversed = computeInputsDigest([...inputs].reverse()).digest;

    expect(reversed).toBe(forward);
  });

  it("moves when a file that existed is now absent", () => {
    const present = computeInputsDigest([
      { content: "export default {};", label: "playwright.config.ts" },
    ]).digest;
    const absent = computeInputsDigest([
      { content: null, label: "playwright.config.ts" },
    ]).digest;

    expect(absent).not.toBe(present);
  });

  it("distinguishes an absent file from an empty one", () => {
    const empty = computeInputsDigest([{ content: "", label: "x" }]).digest;
    const absent = computeInputsDigest([{ content: null, label: "x" }]).digest;

    expect(absent).not.toBe(empty);
  });

  it("distinguishes identical content under different labels", () => {
    // Otherwise moving a config from one filename to another leaves the digest
    // unchanged, and the signal it produces has silently changed category.
    const a = computeInputsDigest([{ content: "{}", label: "jest.config.json" }]).digest;
    const b = computeInputsDigest([{ content: "{}", label: "vitest.config.ts" }]).digest;

    expect(a).not.toBe(b);
  });

  it("reports the labels it folded, sorted", () => {
    expect(computeInputsDigest(inputs).labels).toEqual([
      "mcp.json",
      "package.json",
      "playwright.config.ts",
    ]);
  });
});
