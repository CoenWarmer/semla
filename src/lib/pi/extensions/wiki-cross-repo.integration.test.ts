/**
 * The whole cross-repo path, against the real pi-llm-wiki commitSynthesis.
 *
 * Each piece is unit-tested on its own, but the failure this replaces was an
 * interaction: a page created without a repo, attributed by one rule and then
 * frozen against another. Only running the sequence catches that.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { stampWikiPages } from "@/lib/pi/wiki-repo-stamp";
import { mergeProvenance, withNamespacedEntities } from "./wiki-page-merge.ts";

const WORKER = join(
  process.cwd(),
  ".pi/npm/node_modules/@zosmaai/pi-llm-wiki/extensions/llm-wiki/lib/ingest-worker.ts",
);

type Commit = (
  paths: Record<string, string>,
  sourceId: string,
  manifest: Record<string, unknown>,
  data: unknown,
) => { ok: boolean; entitiesCreated: string[]; conceptsLinked: string[] };

function vault() {
  const root = mkdtempSync(join(tmpdir(), "semla-xrepo-"));
  const dot = join(root, ".llm-wiki");
  for (const dir of ["wiki/entities", "wiki/concepts", "wiki/sources", "raw/sources", "meta"]) {
    mkdirSync(join(dot, dir), { recursive: true });
  }
  writeFileSync(
    join(dot, "config.json"),
    JSON.stringify({
      name: "t", mode: "personal", topic: "t",
      created: "2026-08-28", version: "1.0", knowledge_format: "okf-0.2",
    }),
    "utf8",
  );
  return {
    root,
    paths: {
      root, raw: join(dot, "raw"), rawSources: join(dot, "raw/sources"),
      rawTrajectories: join(dot, "raw/trajectories"), wiki: join(dot, "wiki"),
      meta: join(dot, "meta"), dotWiki: dot, outputs: join(dot, "outputs"),
      discoveries: join(dot, ".discoveries"),
    },
  };
}

const synthesis = (repo: string) =>
  withNamespacedEntities(
    {
      summary: `${repo} summary.`,
      key_takeaways: [`${repo} takeaway`],
      entities: [{ title: "README.md", description: `${repo} readme` }],
      concepts: [{ title: "TypeScript project references", definition: "A shared idea." }],
      quotes: [],
      contradictions: [],
    },
    repo,
  );

describe("two repos sharing one vault", () => {
  it("keeps entities apart and accumulates concept provenance", async () => {
    const { commitSynthesis } = (await import(WORKER)) as { commitSynthesis: Commit };
    const { root, paths } = vault();
    const concept = join(paths.wiki, "concepts", "typescript-project-references.md");

    const attributeSource = (id: string, repo: string) => {
      const p = join(paths.wiki, "sources", `${id}.md`);
      const md = readFileSync(p, "utf8").replace(/^---\n/, `---\nrepo: ${repo}\n`);
      writeFileSync(p, md, "utf8");
    };

    // ── buildkite-tray orients ────────────────────────────────────────────
    const first = commitSynthesis(paths, "SRC-001", { title: "a" }, synthesis("buildkite-tray"));
    expect(first.ok).toBe(true);
    attributeSource("SRC-001", "buildkite-tray");
    stampWikiPages({ slugs: ["buildkite-tray"], since: 0, wikiHome: root });

    expect(readFileSync(concept, "utf8")).toContain("repo: buildkite-tray");

    // ── semla orients into the same vault ─────────────────────────────────
    const second = commitSynthesis(paths, "SRC-002", { title: "b" }, synthesis("semla"));
    expect(second.ok).toBe(true);
    // Its README is a different artifact and gets its own page.
    expect(second.entitiesCreated).toEqual(["semla-readmemd"]);
    // The shared concept is linked, not recreated — this is where the old code
    // dropped semla's evidence on the floor.
    expect(second.conceptsLinked).toContain("typescript-project-references");

    const merged = mergeProvenance(readFileSync(concept, "utf8"), {
      sourceId: "SRC-002",
      repo: "semla",
      date: "2026-08-29",
    });
    writeFileSync(concept, merged.content, "utf8");
    attributeSource("SRC-002", "semla");
    stampWikiPages({ slugs: ["semla"], since: 0, wikiHome: root });

    // ── the outcome ───────────────────────────────────────────────────────
    expect(readdirSync(join(paths.wiki, "entities")).sort()).toEqual([
      "buildkite-tray-readmemd.md",
      "semla-readmemd.md",
    ]);

    const final = readFileSync(concept, "utf8");
    expect(final).toContain("repo: [buildkite-tray, semla]");
    expect(final).toContain("  - id: SRC-001");
    expect(final).toContain("  - id: SRC-002");
    // Provenance merged; prose untouched.
    expect(final).toContain("description: A shared idea.");
  }, 60_000);
});
