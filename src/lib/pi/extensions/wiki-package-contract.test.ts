/**
 * Build-time signal for the parts of @zosmaai/pi-llm-wiki that Semla reaches
 * into directly.
 *
 * Two things about that package are invisible to tsc by construction:
 *
 *  - wiki-ingest-bridge.ts imports three of its internal modules through
 *    *computed* path strings, specifically so tsc will not try to resolve
 *    files outside this project's tsconfig. That also means a release which
 *    moves a file or renames an export breaks wiki synthesis at runtime with
 *    nothing failing at build time.
 *  - The package reaches back into Semla by reading two `Symbol.for()` slots by
 *    literal string. Renaming a key on our side unhooks it silently.
 *
 * These tests are the compensating control, so the package can only break the
 * contract loudly.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  slotName,
  WIKI_INGEST_DISPATCHER,
  WIKI_RECALL_FILTER,
  WIKI_REINDEX_DISPATCHER,
} from "../extension-loading/extension-contract.ts";
import { RELATED_PLACEHOLDER } from "./related-links-sweep.ts";
import { WIKI_PACKAGE_DEEP_IMPORTS } from "./wiki-ingest-bridge.ts";
import { WIKI_SUBAGENT_DEEP_IMPORTS } from "./wiki-subagent-tools.ts";

// Both modules reach into the package through computed paths, so both need the
// same compensating check. A release that renames a tool registrar would
// otherwise leave workflow subagents silently toolless again.
const DEEP_IMPORTS = [...WIKI_PACKAGE_DEEP_IMPORTS, ...WIKI_SUBAGENT_DEEP_IMPORTS];

const WIKI_PACKAGE = "@zosmaai/pi-llm-wiki";
const INSTALLED_DIR = join(process.cwd(), "node_modules", WIKI_PACKAGE);
const ROOT_PACKAGE = () => readJson(join(process.cwd(), "package.json"));

/**
 * The wildcard peer this package declares, and what package.json aliases it
 * onto.
 *
 * `peerDependencies: { "@mariozechner/pi-coding-agent": "*" }` names a scope pi
 * has since been renamed away from, so npm satisfied it by installing a second,
 * older agent runtime — 0.73.1 — carrying three high-severity advisories, one a
 * race in `auth.json` writes that can expose stored credentials. That is what
 * kept this package in a tree of its own, where `npm audit` could not see it
 * from the root.
 *
 * The overrides redirect it onto the runtime this repository already pins.
 * Remove them and the vulnerable copy returns silently, which is why they are
 * asserted rather than trusted to a comment. Only two of the package's imports
 * of it are values — `getAgentDir` and `isToolCallEventType` — and both exist
 * on the renamed package.
 */
const ALIASED_PEERS: Record<string, string> = {
  "@mariozechner/pi-coding-agent": "npm:@earendil-works/pi-coding-agent@0.84.2",
  "@mariozechner/pi-tui": "npm:@earendil-works/pi-tui@0.84.2",
};

const readJson = (path: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;

describe(`${WIKI_PACKAGE} version pin`, () => {
  const declared = (
    ROOT_PACKAGE().dependencies as Record<string, string>
  )[WIKI_PACKAGE];

  it("is a dependency of this repository", () => {
    expect(
      declared,
      `${WIKI_PACKAGE} must be declared in the root package.json — see the ` +
        "extension-dependency decision in AGENTS.md",
    ).toBeDefined();
  });

  it("is pinned to an exact version", () => {
    // A caret range on a package we deep-import into means a patch release can
    // relocate a file and take wiki synthesis down without any commit here.
    expect(
      declared,
      `${WIKI_PACKAGE} must be pinned exactly in package.json, got "${declared}"`,
    ).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("matches the installed copy", () => {
    const installed = readJson(join(INSTALLED_DIR, "package.json")).version;
    expect(
      installed,
      "Installed wiki package differs from the pin. Run `npm install`.",
    ).toBe(declared);
  });

  it.each(Object.entries(ALIASED_PEERS))(
    "aliases the %s peer onto the pinned runtime",
    (peer, alias) => {
      const overrides = (ROOT_PACKAGE().overrides ?? {}) as Record<
        string,
        string
      >;

      expect(
        overrides[peer],
        `Without this override npm satisfies ${WIKI_PACKAGE}'s wildcard peer by ` +
          "installing a second, vulnerable agent runtime. See the docblock above.",
      ).toBe(alias);
    },
  );

  it.each(Object.keys(ALIASED_PEERS))(
    "resolves %s to the aliased package on disk",
    (peer) => {
      // The override is only worth anything if npm actually applied it.
      const resolved = readJson(
        join(process.cwd(), "node_modules", peer, "package.json"),
      );

      expect(resolved.name).toMatch(/^@earendil-works\//);
      expect(resolved.version).toBe("0.84.2");
    },
  );
});

/**
 * The package is patched, and has to be: the dispatcher hook the tests below
 * look for is not in the published tarball. Those edits lived only in
 * `.pi/npm/node_modules`, which is untracked — that directory's .gitignore is
 * `*` — and reproducible by nothing. They survived only because npm does not
 * re-extract a package already matching the lockfile, so `npm ci`, a fresh
 * clone, or one cache miss would have dropped them and left wiki_ingest
 * silently falling back to inline synthesis.
 *
 * They are committed under `patches/` now. Three things have to hold for that
 * to be worth anything: the patch exists, it was cut against the version that
 * is pinned, and something re-applies it after an install.
 */
describe(`${WIKI_PACKAGE} patch`, () => {
  const declared = (
    ROOT_PACKAGE().dependencies as Record<string, string>
  )[WIKI_PACKAGE];
  const patchFile = `${WIKI_PACKAGE.replace("/", "+")}+${declared}.patch`;
  const patchPath = join(process.cwd(), "patches", patchFile);

  it("is committed, cut against the pinned version", () => {
    expect(
      existsSync(patchPath),
      `Expected patches/${patchFile}. A version bump needs the patch re-cut ` +
        "against the new release, not carried over.",
    ).toBe(true);
  });

  it("carries the dispatcher hook the bridge depends on", () => {
    // If this line is not in the patch, nothing puts it in the package, and
    // the hook tests below pass only for as long as the working copy survives.
    expect(readFileSync(patchPath, "utf8")).toContain(
      "semla.wiki-ingest-dispatcher",
    );
  });

  it("is re-applied by the install", () => {
    const postinstall = (
      readJson(join(process.cwd(), "package.json")).scripts as Record<
        string,
        string
      >
    ).postinstall;

    expect(
      postinstall,
      "postinstall must run scripts/apply-package-patches.mjs, or a reinstall " +
        "silently unpatches the package.",
    ).toContain("apply-package-patches.mjs");
  });
});

describe(`${WIKI_PACKAGE} deep imports`, () => {
  it.each(DEEP_IMPORTS)(
    "$path still exists and exports what Semla calls",
    ({ path, exports }) => {
      expect(
        existsSync(path),
        `${path} is gone. Semla imports it at runtime; update the path or pin back.`,
      ).toBe(true);

      const source = readFileSync(path, "utf8");
      for (const name of exports) {
        // Matches `export function x`, `export async function x`, `export const x`,
        // and `export { x }` / `export { y as x }`.
        const declaration = new RegExp(
          String.raw`export\s+(async\s+)?(function|const|let|class)\s+${name}\b`,
        );
        const reExport = new RegExp(
          String.raw`export\s*\{[^}]*\b${name}\b[^}]*\}`,
        );
        expect(
          declaration.test(source) || reExport.test(source),
          `${path} no longer exports "${name}", which Semla calls at runtime.`,
        ).toBe(true);
      }
    },
  );
});

describe(`${WIKI_PACKAGE} dispatcher hooks`, () => {
  // The package looks these up by literal string, so the contract only holds
  // while both sides spell them identically.
  const toolsSource = readFileSync(
    join(INSTALLED_DIR, "extensions/llm-wiki/lib/tools.ts"),
    "utf8",
  );

  it.each([
    ["ingest", WIKI_INGEST_DISPATCHER],
    ["reindex", WIKI_REINDEX_DISPATCHER],
  ])("still reads the %s dispatcher slot", (_label, key) => {
    expect(
      toolsSource.includes(`Symbol.for("${key.description}")`),
      `pi-llm-wiki no longer reads Symbol.for("${key.description}"). ` +
        "The bridge would install a dispatcher nothing calls, and wiki_ingest " +
        "would silently fall back to inline synthesis.",
    ).toBe(true);
  });

  /**
   * Both dispatcher slots hold one function for the whole process, because an
   * external caller cannot index a session map — so the calling session's id
   * has to arrive as an argument instead. That argument comes from this
   * repository's own patch, and losing it is silent: the bridge falls back to
   * whichever session registered the dispatcher last, which is the wrong one
   * exactly when two sessions are running.
   */
  it.each([
    ["ingest", "semlaDispatcher(sources.map"],
    ["reindex", "reindexDispatcher({"],
  ])("still passes the calling session id to the %s dispatcher", (label, call) => {
    const at = toolsSource.indexOf(call);
    expect(at, `the ${label} dispatcher call site has moved or changed shape`).toBeGreaterThan(-1);

    // A window either side of the call: the ingest site assigns the id on the
    // line above and passes it positionally, the reindex site reads it inline
    // into the argument object.
    const statement = toolsSource.slice(Math.max(0, at - 400), at + 400);
    expect(
      /getSessionId/.test(statement),
      `pi-llm-wiki calls the ${label} dispatcher without a session id. ` +
        "Re-cut patches/@zosmaai+pi-llm-wiki+0.11.5.patch: without it the " +
        "bridge cannot tell whose ingest it is running, and two concurrent " +
        "sessions silently cross over.",
    ).toBe(true);
  });
});

/**
 * The orient skill's "record the decisions" step writes analysis pages, because
 * commitSynthesis only ever produces entities and concepts — the reasoning
 * behind the code gets no page of its own otherwise. That step is only possible
 * while wiki_ensure_page accepts the type and files it somewhere the nav reads.
 */
describe(`${WIKI_PACKAGE} page types`, () => {
  const toolsSource = readFileSync(
    join(INSTALLED_DIR, "extensions/llm-wiki/lib/tools.ts"),
    "utf8",
  );

  it("still lets wiki_ensure_page create an analysis page", () => {
    expect(
      /analysis:\s*"analyses"/.test(toolsSource),
      "wiki_ensure_page no longer maps the analysis type to the analyses folder. " +
        "The orient skill's decision pages would silently land in concepts/.",
    ).toBe(true);
  });

  it("keeps the folder the wiki nav groups analyses under", () => {
    // NAV_GROUP_ORDER in wiki-types.ts renders an "analysis" group; a page
    // filed elsewhere would exist but never appear in the browser.
    expect(toolsSource).toContain('analysis: "analyses"');
  });
});

/**
 * The auto-recall scoping added by `patches/`. Three separate things have to
 * survive a package upgrade, and all three fail silently:
 *
 *  - the candidate width and the `minScore` floor, which have to move together.
 *    The floor matches the package's shipped 5, so a diff that reverted it
 *    looks like a no-op — but 5 on the unnormalised scale admits nearly
 *    everything, and this pairing only holds while `recall.ts` normalises;
 *  - the `Symbol.for("semla.wiki-recall-filter")` lookup, which is the only
 *    thing that drops off-repo pages. Losing it puts 47.4% cross-repo hits
 *    back, and nothing errors because the slot is simply never read;
 *  - the `.slice(0, 3)`, which is what keeps the widened 12-candidate search
 *    from injecting twelve pages per turn. Losing this one is the expensive
 *    failure, so it is asserted separately from the widening it pairs with.
 */
describe(`${WIKI_PACKAGE} auto-recall scoping`, () => {
  const indexSource = readFileSync(
    join(INSTALLED_DIR, "extensions/llm-wiki/index.ts"),
    "utf8",
  );

  it("searches the widened candidate set, at the paraphrase floor", () => {
    expect(
      /searchWikiHybrid\(paths,\s*prompt,\s*12,\s*5,/.test(indexSource),
      "The auto-recall search is no longer (12, 5). The 12 is what gives the " +
        "repo filter something to keep — at 3, the top candidates are " +
        "frequently all off-repo and the injection lands empty. The 5 is the " +
        "highest floor that still admits a page matched on meaning alone " +
        "(cosine 0.84 contributes 5.04 at the default weight), and it is only " +
        "meaningful because recall.ts normalises the lexical score. Re-cut the " +
        "patch rather than adjusting either number alone.",
    ).toBe(true);
  });

  it("reads the recall filter out of the contract slot", () => {
    expect(indexSource).toContain(slotName(WIKI_RECALL_FILTER));
  });

  it("still caps the injection at three pages after filtering", () => {
    expect(
      /\.slice\(0,\s*3\)/.test(indexSource),
      "The slice after the recall filter is gone, so the widened 12-candidate " +
        "search would inject up to 12 pages on every prompt.",
    ).toBe(true);
  });

  it("passes the calling session's id to the filter", () => {
    // Without it the filter cannot tell which session's repos to scope to, and
    // it fails open — no error, just unfiltered recall again.
    expect(indexSource).toContain("sessionManager?.getSessionId?.()");
  });
});

/**
 * The query-length normalisation added by `patches/`, and the two package
 * constants the floor is calibrated against.
 *
 * The package scores a page by adding a field weight for every query term found
 * in each of sixteen metadata fields, with no division by term count. The sum
 * therefore grows with prompt length — 35 at the median for prompts under ten
 * distinct terms, 107 for prompts over twenty-five, measured over 394 recalls —
 * so an absolute `minScore` tests verbosity, and the semantic term, capped at
 * `weight * SEMANTIC_SCALE`, cannot outrank a page that merely shares a common
 * word.
 *
 * Losing the division is silent in the worst way: recall keeps working, scores
 * return to their old magnitude, and the floor in `index.ts` — set on the
 * normalised scale — then admits everything it was chosen to exclude while the
 * semantic ranking goes back to being a rounding error.
 */
describe(`${WIKI_PACKAGE} recall score normalisation`, () => {
  const recallSource = readFileSync(
    join(INSTALLED_DIR, "extensions/llm-wiki/lib/recall.ts"),
    "utf8",
  );

  it("divides the lexical score by the query's term count", () => {
    expect(
      /for \(const item of scored\) item\.score \/= terms\.length;/.test(recallSource),
      "The normalisation is gone. Scores revert to an unnormalised sum, which " +
        "makes the floor in index.ts a prompt-length test and reduces the " +
        "semantic signal to a tiebreaker. Re-cut the patch.",
    ).toBe(true);
  });

  it("normalises after pseudo-relevance feedback and before semantic fusion", () => {
    // PRF adds points on the lexical scale, so it has to be inside the
    // division; fusion adds points on the semantic scale, so it has to be
    // outside it. Getting either side wrong silently rescales one signal.
    const prf = recallSource.indexOf("item.score += expChunkScore * 0.4");
    const normalise = recallSource.indexOf("item.score /= terms.length");
    const fuse = recallSource.indexOf("item.score = fuseScores(");

    expect(prf).toBeGreaterThan(-1);
    expect(fuse).toBeGreaterThan(-1);
    expect(normalise).toBeGreaterThan(prf);
    expect(normalise).toBeLessThan(fuse);
  });

  it("pins the constants the floor was calibrated against", () => {
    // The floor is a number on a scale these two define. A release that
    // changed either would move every score without changing a line here.
    expect(recallSource).toContain("export const SEMANTIC_SCALE = 12;");
    expect(recallSource).toContain("export const DEFAULT_SEMANTIC_WEIGHT = 0.5;");
  });
});

/**
 * `related-links-sweep.ts` fills in a section this package writes and never
 * completes, and it recognises that section by matching the placeholder line
 * verbatim. So the literal is the contract: a release that reworded it, or
 * started filling the section itself, would turn the sweep into a silent no-op
 * and put every retro note back on the consolidate skill's deletion list.
 *
 * Matching the literal rather than the heading is deliberate — it is what
 * makes the sweep idempotent and keeps it from overwriting a Related section
 * the agent did fill in.
 */
describe(`${WIKI_PACKAGE} Related placeholder`, () => {
  const retroSource = readFileSync(
    join(INSTALLED_DIR, "extensions/llm-wiki/lib/retro.ts"),
    "utf8",
  );

  it("still writes the placeholder the sweep replaces", () => {
    expect(
      retroSource.includes(RELATED_PLACEHOLDER),
      `saveInsight no longer writes "${RELATED_PLACEHOLDER}". Either it fills ` +
        "the Related section itself now — in which case delete the sweep — or " +
        "it reworded the line and the sweep silently stopped connecting notes.",
    ).toBe(true);
  });

  it("still writes it under a Related heading", () => {
    expect(retroSource).toContain("## Related");
  });
});
