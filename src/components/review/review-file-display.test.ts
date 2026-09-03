import { describe, expect, it } from "vitest";

import type { ChangeStatus } from "@/lib/review-types";

import {
  renameLabel,
  splitPath,
  STATUS_LABEL,
  STATUS_TONE,
  TONE_CLASS,
} from "./review-file-display.ts";

const ALL: ChangeStatus[] = [
  "added",
  "copied",
  "deleted",
  "modified",
  "renamed",
  "type-changed",
  "unmerged",
  "untracked",
];

describe("status presentation", () => {
  it("labels and tones every status, so none renders blank", () => {
    for (const status of ALL) {
      expect(STATUS_LABEL[status]).toMatch(/^.$/);
      expect(TONE_CLASS[STATUS_TONE[status]]).toBeTruthy();
    }
  });

  it("uses git's own letters", () => {
    expect(STATUS_LABEL.modified).toBe("M");
    expect(STATUS_LABEL.deleted).toBe("D");
    expect(STATUS_LABEL.untracked).toBe("?");
  });

  it("singles out a conflict rather than colouring it like an edit", () => {
    // An unmerged file is not a change to review; it is a repository that
    // needs attention first.
    expect(STATUS_TONE.unmerged).toBe("attention");
    expect(STATUS_TONE.modified).toBe("changed");
  });
});

describe("splitPath", () => {
  it("separates the directory so the filename can lead", () => {
    expect(splitPath("src/lib/pi/git.ts")).toEqual({
      dir: "src/lib/pi/",
      name: "git.ts",
    });
  });

  it("handles a file at the root", () => {
    expect(splitPath("AGENTS.md")).toEqual({ dir: "", name: "AGENTS.md" });
  });
});

describe("renameLabel", () => {
  it("shows both names for a rename", () => {
    expect(renameLabel("src/old.ts", "src/new.ts")).toBe("old.ts → new.ts");
  });

  it("shows one name when nothing was renamed", () => {
    expect(renameLabel(null, "src/new.ts")).toBe("new.ts");
  });
});
