import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  parseSplits,
  parseSplitsBody,
  pruneSplits,
  readFileSplits,
  validSplitKeys,
  writeFileSplits,
} from "./review-split-store";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "semla-splits-"));
});

afterEach(() => {
  rmSync(dir, { force: true, recursive: true });
});

describe("review split store", () => {
  it("reads nothing before anything is written", () => {
    expect(readFileSplits("/repo", "a.ts", dir)).toEqual({});
  });

  it("keeps files of one repository apart, and repositories apart", () => {
    writeFileSplits("/repo", "a.ts", { k: [2] }, dir);
    writeFileSplits("/repo", "b.ts", { k: [3] }, dir);
    writeFileSplits("/other", "a.ts", { k: [4] }, dir);

    expect(readFileSplits("/repo", "a.ts", dir)).toEqual({ k: [2] });
    expect(readFileSplits("/repo", "b.ts", dir)).toEqual({ k: [3] });
    expect(readFileSplits("/other", "a.ts", dir)).toEqual({ k: [4] });
  });

  it("removes a file's entry when it is written empty", () => {
    writeFileSplits("/repo", "a.ts", { k: [2] }, dir);
    writeFileSplits("/repo", "a.ts", {}, dir);
    expect(readFileSplits("/repo", "a.ts", dir)).toEqual({});
  });
});

describe("parseSplits", () => {
  it("accepts a record of positive integer boundaries", () => {
    expect(parseSplits({ k: [1, 3] })).toEqual({ k: [1, 3] });
  });

  it.each([null, [], "k", { k: "1" }, { k: [0] }, { k: [1.5] }])(
    "rejects %j",
    (value) => {
      expect(parseSplits(value)).toBeNull();
    },
  );
});

describe("parseSplitsBody", () => {
  it("defaults a missing project to the anchor", () => {
    expect(parseSplitsBody({ path: "a.ts", splits: {} })).toEqual({
      path: "a.ts",
      project: null,
      splits: {},
    });
  });

  it.each([null, { splits: {} }, { path: "", splits: {} }, { path: "a.ts" }])(
    "rejects %j",
    (value) => {
      expect(parseSplitsBody(value)).toBeNull();
    },
  );
});

describe("validSplitKeys", () => {
  it("is empty for a file with no changes", () => {
    expect(validSplitKeys(null).size).toBe(0);
  });
});

describe("pruneSplits", () => {
  it("drops keys the diffs no longer have, and empty entries", () => {
    expect(
      pruneSplits({ empty: [], gone: [1], live: [2] }, new Set(["empty", "live"])),
    ).toEqual({ live: [2] });
  });
});
