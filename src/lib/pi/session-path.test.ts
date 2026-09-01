/**
 * The leaf rule is the load-bearing assertion here.
 *
 * Pi resolves an unspecified leaf as the last entry in the file. If this module
 * ever picks a different one, the transcript on screen drifts away from the
 * context the model is given — silently, which is how the original bug survived.
 * The "matches Pi" test exists to fail loudly if someone reasons their way to a
 * cleverer leaf.
 */
import { describe, expect, it } from "vitest";

import { activePath, supersededSiblings } from "./session-path.ts";

type Entry = { id: string; parentId: string | null; text?: string };

const ids = (entries: Entry[]) => entries.map((entry) => entry.id);

/** a -> b -> c, no branches. */
const linear: Entry[] = [
  { id: "a", parentId: null },
  { id: "b", parentId: "a" },
  { id: "c", parentId: "b" },
];

/**
 * a -> b1 -> c1   (abandoned)
 *   \-> b2 -> c2  (live: c2 is last in the file)
 */
const branched: Entry[] = [
  { id: "a", parentId: null },
  { id: "b1", parentId: "a", text: "first attempt" },
  { id: "c1", parentId: "b1" },
  { id: "b2", parentId: "a", text: "second attempt" },
  { id: "c2", parentId: "b2" },
];

describe("activePath", () => {
  it("returns a linear session unchanged", () => {
    expect(ids(activePath(linear))).toEqual(["a", "b", "c"]);
  });

  it("returns only the live path through a fork", () => {
    expect(ids(activePath(branched))).toEqual(["a", "b2", "c2"]);
  });

  it("takes the last entry as the leaf, as Pi does", () => {
    // buildSessionPath in session-manager.js: leaf ??= entries[entries.length-1].
    // Diverging here puts the UI back out of step with the model.
    const abandonedLast = [...branched.slice(0, 3), ...branched.slice(3)];
    expect(ids(activePath(abandonedLast)).at(-1)).toBe("c2");

    // Reordering so an abandoned entry is last moves the live path with it.
    const reordered = [branched[0], branched[3], branched[4], branched[1], branched[2]];
    expect(ids(activePath(reordered))).toEqual(["a", "b1", "c1"]);
  });

  it("handles a root-only session", () => {
    expect(ids(activePath([{ id: "a", parentId: null }]))).toEqual(["a"]);
  });

  it("returns nothing for no entries", () => {
    expect(activePath([])).toEqual([]);
  });

  it("stops at a missing parent rather than dropping the entry", () => {
    // A truncated or hand-edited file can orphan an entry. Showing the tail is
    // better than showing nothing.
    expect(ids(activePath([{ id: "b", parentId: "gone" }]))).toEqual(["b"]);
  });

  it("does not hang on a parent cycle", () => {
    const cyclic: Entry[] = [
      { id: "a", parentId: "b" },
      { id: "b", parentId: "a" },
    ];

    expect(ids(activePath(cyclic)).length).toBeLessThanOrEqual(2);
  });
});

describe("supersededSiblings", () => {
  it("reports the version a live entry replaced", () => {
    const superseded = supersededSiblings(branched);

    expect(superseded.get("b2")?.map((entry) => entry.text)).toEqual([
      "first attempt",
    ]);
  });

  it("does not include the abandoned replies under that version", () => {
    // c1 hangs off b1, but "what did this prompt say before" does not want it.
    expect(supersededSiblings(branched).get("b2")).toHaveLength(1);
  });

  it("reports nothing for an unbranched session", () => {
    expect(supersededSiblings(linear).size).toBe(0);
  });

  it("treats re-edited first messages as siblings", () => {
    // resetLeaf() makes the next entry a new root, so the earlier first message
    // is a sibling at the root level rather than a child of anything.
    const roots: Entry[] = [
      { id: "a1", parentId: null, text: "original opener" },
      { id: "a2", parentId: null, text: "edited opener" },
    ];

    expect(supersededSiblings(roots).get("a2")?.map((entry) => entry.text)).toEqual([
      "original opener",
    ]);
  });

  it("keeps siblings in file order, oldest attempt first", () => {
    const thrice: Entry[] = [
      { id: "a", parentId: null },
      { id: "v1", parentId: "a", text: "one" },
      { id: "v2", parentId: "a", text: "two" },
      { id: "v3", parentId: "a", text: "three" },
    ];

    expect(supersededSiblings(thrice).get("v3")?.map((entry) => entry.text)).toEqual([
      "one",
      "two",
    ]);
  });
});
