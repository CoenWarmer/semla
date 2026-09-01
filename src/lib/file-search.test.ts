import { describe, expect, it } from "vitest";

import { matchScore, rankMatches, type FileMatch } from "@/lib/file-search";

const file = (path: string, inProject = false): FileMatch => ({
  inProject,
  name: path.slice(path.lastIndexOf("/") + 1),
  path,
});

describe("matchScore", () => {
  it("prefers the basename over the path", () => {
    const basename = matchScore("route", "semla/route.ts")!;
    const inPath = matchScore("route", "semla/routes/handler.ts")!;
    expect(basename).toBeLessThan(inPath);
  });

  it("ranks exact, prefix and substring basename matches in that order", () => {
    expect(matchScore("page", "a/page")).toBeLessThan(
      matchScore("page", "a/page.tsx")!,
    );
    expect(matchScore("page", "a/page.tsx")).toBeLessThan(
      matchScore("page", "a/my-page.tsx")!,
    );
  });

  it("is case insensitive", () => {
    expect(matchScore("README", "a/readme.md")).not.toBeNull();
  });

  it("reports no match rather than a weak one", () => {
    expect(matchScore("zzz", "a/page.tsx")).toBeNull();
  });

  it("treats a blank query as no match, so an empty box lists nothing", () => {
    expect(matchScore("   ", "a/page.tsx")).toBeNull();
  });
});

describe("rankMatches", () => {
  it("puts every project match above every other match", () => {
    // The outside match scores better on name alone: project still wins.
    const ranked = rankMatches(
      "page",
      [file("other/page.tsx"), file("semla/src/my-page.tsx", true)],
      10,
    );
    expect(ranked.map((match) => match.path)).toEqual([
      "semla/src/my-page.tsx",
      "other/page.tsx",
    ]);
  });

  it("breaks ties on match quality, then depth, then name", () => {
    const ranked = rankMatches(
      "page",
      [
        file("a/b/c/page.tsx", true),
        file("a/page.tsx", true),
        file("a/other-page.tsx", true),
      ],
      10,
    );
    expect(ranked.map((match) => match.path)).toEqual([
      "a/page.tsx",
      "a/b/c/page.tsx",
      "a/other-page.tsx",
    ]);
  });

  it("drops non-matches and caps the result", () => {
    const ranked = rankMatches(
      "page",
      [file("a/page.tsx"), file("a/nothing.ts"), file("b/page.ts")],
      1,
    );
    expect(ranked).toHaveLength(1);
    expect(ranked[0].path).toBe("a/page.tsx");
  });

  it("orders identically whatever order the walk produced", () => {
    const candidates = [
      file("z/page.tsx", true),
      file("a/page.tsx", true),
      file("m/page.tsx"),
    ];
    const forward = rankMatches("page", candidates, 10);
    const reversed = rankMatches("page", [...candidates].reverse(), 10);
    expect(forward).toEqual(reversed);
  });
});
