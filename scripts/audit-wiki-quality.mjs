/**
 * Audit the factual quality of one repo's wiki pages against the repo itself.
 *
 * Recall can only be as good as what it ranks, so before tuning the ranking it
 * is worth knowing whether the corpus is true. Four checks, cheapest first,
 * and all of them are objective — no model in the loop:
 *
 *   1. STALE PATHS   — a `src/...` path the page cites that no longer exists.
 *      Split into "moved" (the basename still exists somewhere, so the page is
 *      out of date) and "gone" (no file of that name anywhere, so the page is
 *      either wrong or describes deleted code).
 *   2. BROKEN LINKS  — a `](/concepts/foo.md)` target with no file behind it.
 *      These are load-bearing: the page's own Links section is how an agent is
 *      meant to traverse the vault.
 *   3. STUBS         — a page whose body says nothing its frontmatter
 *      `description` did not already say. Costs a recall slot, teaches nothing.
 *   4. AGE           — `updated` against the last commit that touched the repo
 *      paths the page cites. A page older than the code it describes is a
 *      claim that has not been rechecked since the code moved under it.
 *
 * Usage:
 *   node scripts/audit-wiki-quality.mjs [--repo semla] [--json] [--list stale]
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

const VAULT = ".semla-wiki/.llm-wiki";
const WIKI = join(VAULT, "wiki");
const REGISTRY = join(VAULT, "meta/registry.json");

const args = process.argv.slice(2);
const repoFilter = args.includes("--repo") ? args[args.indexOf("--repo") + 1] : "semla";
const asJson = args.includes("--json");
const listWhat = args.includes("--list") ? args[args.indexOf("--list") + 1] : null;

/** Paths a page might cite that live in this repository, by extension. */
const CODE_PATH = /(?:^|[\s`("'[<])((?:src|scripts|docs|supabase|patches|public)\/[\w./[\]@-]*\.\w{2,4})/g;
/** Markdown links into the vault, e.g. `](/concepts/foo.md)`. */
const VAULT_LINK = /\]\((\/(?:concepts|entities|sources|analyses|syntheses|requirements)\/[^)]+)\)/g;
/** Wikilink form, e.g. `[[concepts/foo]]`. */
const WIKILINK = /\[\[([^\]|]+?)(?:\|[^\]]*)?\]\]/g;

/** Every tracked file in the repo, indexed by full path and by basename. */
function indexRepo() {
  const files = execFileSync("git", ["ls-files"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    .split("\n")
    .filter(Boolean);
  const byPath = new Set(files);
  const byBase = new Map();
  for (const f of files) {
    const b = basename(f);
    if (!byBase.has(b)) byBase.set(b, []);
    byBase.get(b).push(f);
  }
  return { byPath, byBase };
}

/** Last commit date touching any of `paths`, or null when none are tracked. */
function lastTouched(paths) {
  if (paths.length === 0) return null;
  try {
    const out = execFileSync("git", ["log", "-1", "--format=%cs", "--", ...paths], {
      encoding: "utf8",
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

function splitFrontmatter(raw) {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: raw };
  const meta = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([a-z_]+):\s*(.*)$/i);
    if (kv && kv[2]) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, "");
  }
  return { meta, body: m[2] };
}

/**
 * Substantive prose in a page body: drop headings, link-list bullets, code
 * fences and frontmatter echoes. What remains is what the page actually
 * asserts beyond its own metadata.
 */
function substantiveProse(body, description) {
  const withoutFences = body.replace(/```[\s\S]*?```/g, " ");
  const lines = withoutFences
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && !/^[-*]\s*\[.+\]\(.+\)\s*$/.test(l));
  let prose = lines.join(" ");
  if (description) prose = prose.split(description).join(" ");
  return prose.replace(/\s+/g, " ").trim();
}

function walkPages(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walkPages(full, out);
    else if (name.endsWith(".md")) out.push(full);
  }
  return out;
}

function main() {
  const registry = JSON.parse(readFileSync(REGISTRY, "utf8"));
  const repo = indexRepo();

  const pageIds = new Set();
  for (const file of walkPages(WIKI)) {
    pageIds.add(file.slice(WIKI.length + 1).replace(/\.md$/, ""));
  }

  const pages = [];
  for (const [id, entry] of Object.entries(registry.pages)) {
    const repos = Array.isArray(entry.repo)
      ? entry.repo
      : typeof entry.repo === "string" && entry.repo
        ? entry.repo.split(",")
        : [];
    if (!repos.includes(repoFilter)) continue;

    const file = join(WIKI, `${id}.md`);
    if (!existsSync(file)) {
      pages.push({ id, missingFile: true });
      continue;
    }
    const raw = readFileSync(file, "utf8");
    const { meta, body } = splitFrontmatter(raw);
    const prose = substantiveProse(body, meta.description ?? meta.summary);

    const citedPaths = [...new Set([...body.matchAll(CODE_PATH)].map((m) => m[1]))];
    const moved = [];
    const gone = [];
    const live = [];
    for (const p of citedPaths) {
      if (repo.byPath.has(p)) live.push(p);
      else if (repo.byBase.has(basename(p))) moved.push({ cited: p, nowAt: repo.byBase.get(basename(p)) });
      else gone.push(p);
    }

    const linkTargets = [
      ...[...body.matchAll(VAULT_LINK)].map((m) => m[1].replace(/^\//, "").replace(/\.md$/, "")),
      ...[...body.matchAll(WIKILINK)].map((m) => m[1]),
    ];
    const brokenLinks = [...new Set(linkTargets.filter((t) => !pageIds.has(t)))];

    pages.push({
      id,
      type: entry.type ?? meta.type ?? "?",
      updated: entry.updated ?? meta.updated ?? null,
      proseChars: prose.length,
      isStub: prose.length < 200,
      citedPaths: citedPaths.length,
      live,
      moved,
      gone,
      linkTargets: linkTargets.length,
      brokenLinks,
      codeLastTouched: lastTouched(live.concat(moved.flatMap((m) => m.nowAt))),
    });
  }

  const withPaths = pages.filter((p) => p.citedPaths > 0);
  const anyStale = pages.filter((p) => p.moved?.length || p.gone?.length);
  const stubs = pages.filter((p) => p.isStub);
  const brokenLinkPages = pages.filter((p) => p.brokenLinks?.length);
  const staleVsCode = pages.filter(
    (p) => p.updated && p.codeLastTouched && p.updated < p.codeLastTouched,
  );

  const byType = {};
  for (const p of pages) {
    const t = p.type ?? "?";
    byType[t] ??= { pages: 0, stubs: 0, stale: 0, brokenLinks: 0, citing: 0 };
    byType[t].pages++;
    if (p.isStub) byType[t].stubs++;
    if (p.moved?.length || p.gone?.length) byType[t].stale++;
    if (p.brokenLinks?.length) byType[t].brokenLinks++;
    if (p.citedPaths > 0) byType[t].citing++;
  }

  const report = {
    repo: repoFilter,
    pages: pages.length,
    citeNoCode: pages.length - withPaths.length,
    grounding: {
      pagesCitingCode: withPaths.length,
      pathsCited: pages.reduce((n, p) => n + (p.citedPaths ?? 0), 0),
      pathsLive: pages.reduce((n, p) => n + (p.live?.length ?? 0), 0),
      pathsMoved: pages.reduce((n, p) => n + (p.moved?.length ?? 0), 0),
      pathsGone: pages.reduce((n, p) => n + (p.gone?.length ?? 0), 0),
      pagesWithAnyStalePath: anyStale.length,
      staleShareOfCitingPages: +((anyStale.length / (withPaths.length || 1)) * 100).toFixed(1),
    },
    links: {
      targetsCited: pages.reduce((n, p) => n + (p.linkTargets ?? 0), 0),
      brokenTargets: pages.reduce((n, p) => n + (p.brokenLinks?.length ?? 0), 0),
      pagesWithBrokenLinks: brokenLinkPages.length,
      shareOfPages: +((brokenLinkPages.length / (pages.length || 1)) * 100).toFixed(1),
    },
    substance: {
      stubs: stubs.length,
      stubShare: +((stubs.length / (pages.length || 1)) * 100).toFixed(1),
      medianProseChars: (() => {
        const s = pages.map((p) => p.proseChars ?? 0).sort((a, b) => a - b);
        return s[Math.floor(s.length / 2)] ?? 0;
      })(),
    },
    freshness: {
      pagesOlderThanTheCodeTheyCite: staleVsCode.length,
      shareOfDatablePages: +(
        (staleVsCode.length / (pages.filter((p) => p.updated && p.codeLastTouched).length || 1)) *
        100
      ).toFixed(1),
    },
    byType,
  };

  if (asJson) {
    console.log(JSON.stringify({ report, pages }, null, 2));
    return;
  }

  console.log(JSON.stringify(report, null, 2));

  if (listWhat === "stale") {
    console.log("\nPages citing paths that no longer exist:\n");
    for (const p of anyStale.sort((a, b) => b.moved.length + b.gone.length - (a.moved.length + a.gone.length))) {
      console.log(`  ${p.id}  (updated ${p.updated})`);
      for (const m of p.moved) console.log(`    MOVED ${m.cited}  ->  ${m.nowAt.slice(0, 2).join(", ")}`);
      for (const g of p.gone) console.log(`    GONE  ${g}`);
    }
  }

  if (listWhat === "stubs") {
    console.log("\nStub pages (under 200 chars of prose beyond their own description):\n");
    for (const p of stubs.sort((a, b) => a.proseChars - b.proseChars)) {
      console.log(`  ${String(p.proseChars).padStart(4)} chars  ${p.id}`);
    }
  }

  if (listWhat === "links") {
    console.log("\nPages with broken vault links:\n");
    for (const p of brokenLinkPages.sort((a, b) => b.brokenLinks.length - a.brokenLinks.length)) {
      console.log(`  ${p.id}  (${p.brokenLinks.length} broken)`);
      for (const b of p.brokenLinks.slice(0, 6)) console.log(`    -> ${b}`);
    }
  }
}

main();
