/**
 * The filter's job is to drop off-repo pages, and its more important job is to
 * never drop everything. A session whose recall silently returns nothing is
 * indistinguishable from an empty wiki, so the fail-open cases below matter
 * more than the filtering ones — and the object-identity test exists because
 * the package renders fields this contract does not name, so returning copies
 * would strip the title and preview off every injected page.
 */
import { describe, expect, it } from "vitest";

import type { WikiRecallCandidate } from "../extension-loading/extension-contract.ts";
import { filterRecallToRepos } from "./wiki-recall-filter.ts";

const page = (id: string, score = 60): WikiRecallCandidate => ({
  id,
  path: `/vault/${id}.md`,
  score,
});

/** Stands in for reading `repo:` off disk. */
const repos = (map: Record<string, string[] | null>) => (path: string) => {
  const id = path.replace("/vault/", "").replace(/\.md$/, "");
  return map[id] ?? null;
};

describe("filterRecallToRepos", () => {
  it("keeps a page belonging to the session's repo", () => {
    const candidates = [page("concepts/a")];
    const kept = filterRecallToRepos(candidates, ["semla"], repos({ "concepts/a": ["semla"] }));

    expect(kept).toEqual(candidates);
  });

  it("drops a page belonging only to another repo", () => {
    const kept = filterRecallToRepos(
      [page("concepts/a")],
      ["semla"],
      repos({ "concepts/a": ["kibana"] }),
    );

    expect(kept).toEqual([]);
  });

  it("keeps a page shared with the session's repo", () => {
    const candidates = [page("concepts/a")];
    const kept = filterRecallToRepos(
      candidates,
      ["semla"],
      repos({ "concepts/a": ["kibana", "semla"] }),
    );

    expect(kept).toEqual(candidates);
  });

  it("keeps a page for any of several session repos", () => {
    const candidates = [page("concepts/a")];
    const kept = filterRecallToRepos(
      candidates,
      ["semla", "kibana"],
      repos({ "concepts/a": ["kibana"] }),
    );

    expect(kept).toEqual(candidates);
  });

  it("preserves the search's ranking order", () => {
    const candidates = [page("concepts/a", 90), page("concepts/b", 70), page("concepts/c", 50)];
    const kept = filterRecallToRepos(
      candidates,
      ["semla"],
      repos({ "concepts/a": ["semla"], "concepts/b": ["kibana"], "concepts/c": ["semla"] }),
    );

    expect(kept.map((c) => c.id)).toEqual(["concepts/a", "concepts/c"]);
  });

  it("returns the same object references, not copies", () => {
    const candidates = [page("concepts/a")];
    const kept = filterRecallToRepos(candidates, ["semla"], repos({ "concepts/a": ["semla"] }));

    expect(kept[0]).toBe(candidates[0]);
  });

  describe("fails open", () => {
    it("keeps everything when the session's repos are unknown", () => {
      const candidates = [page("concepts/a"), page("concepts/b")];
      const kept = filterRecallToRepos(
        candidates,
        [],
        repos({ "concepts/a": ["kibana"], "concepts/b": ["ecs"] }),
      );

      expect(kept).toEqual(candidates);
    });

    it("keeps a page that declares no repo, since concepts are shared by design", () => {
      const candidates = [page("concepts/rag")];
      const kept = filterRecallToRepos(candidates, ["semla"], repos({ "concepts/rag": null }));

      expect(kept).toEqual(candidates);
    });

    it("keeps a page whose repo field is an empty list", () => {
      const candidates = [page("concepts/a")];
      const kept = filterRecallToRepos(candidates, ["semla"], repos({ "concepts/a": [] }));

      expect(kept).toEqual(candidates);
    });

    it("keeps a page it cannot read", () => {
      const candidates = [page("concepts/a")];
      const kept = filterRecallToRepos(candidates, ["semla"], () => {
        throw new Error("EACCES");
      });

      expect(kept).toEqual(candidates);
    });
  });

  it("does not mutate the array it was given", () => {
    const candidates = [page("concepts/a"), page("concepts/b")];
    filterRecallToRepos(
      candidates,
      ["semla"],
      repos({ "concepts/a": ["kibana"], "concepts/b": ["kibana"] }),
    );

    expect(candidates).toHaveLength(2);
  });
});
