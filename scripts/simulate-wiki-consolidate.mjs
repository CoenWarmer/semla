/**
 * Dry-run the `consolidate` skill's three passes over one repo's wiki pages.
 *
 * The skill (src/lib/pi/extensions/dynamic-workflows/skills/consolidate/SKILL.md)
 * is agent-driven and gated on two human approvals, so it cannot be executed
 * to find out what it would propose. Its detection rules are mechanical
 * though, so they can be applied directly:
 *
 *   Pass A  topological — orphans (no links in or out, older than 7 days) are
 *           deletion candidates; pages under ~200 WORDS, or with in-links but
 *           no out-links, are stub candidates.
 *   Pass B  structural — within one page type, any two titles sharing a
 *           2-token sequence are a merge candidate. Pages flagged by A are
 *           skipped.
 *   Pass C  semantic — near-duplicate detection via recall, hard-capped at 20
 *           pages. Only the cap is simulated here; the ranking is not.
 *   Step 8  placeholder sweep — removes `## Overview` / `[Key facts]` and
 *           `## Definition` / `[Clear explanation]` pairs.
 *
 * The point of running it is to find out whether the skill addresses what the
 * quality audit found. Where a rule would misfire on this vault, that is
 * reported too rather than smoothed over.
 *
 * Usage: node scripts/simulate-wiki-consolidate.mjs [--repo semla] [--list b]
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const VAULT = ".semla-wiki/.llm-wiki";
const WIKI = join(VAULT, "wiki");
const args = process.argv.slice(2);
const repoFilter = args.includes("--repo") ? args[args.indexOf("--repo") + 1] : "semla";
const listWhat = args.includes("--list") ? args[args.indexOf("--list") + 1] : null;

const STUB_WORDS = 200;
const ORPHAN_AGE_DAYS = 7;
const PASS_C_CAP = 20;
const PLACEHOLDERS = [
  ["## Overview", "[Key facts]"],
  ["## Definition", "[Clear explanation]"],
];

const VAULT_LINK = /\]\((\/(?:concepts|entities|sources|analyses|syntheses|requirements)\/[^)]+)\)/g;
const WIKILINK = /\[\[([^\]|]+?)(?:\|[^\]]*)?\]\]/g;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith(".md")) out.push(full);
  }
  return out;
}

function frontmatter(raw) {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: raw };
  const meta = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([a-z_]+):\s*(.*)$/i);
    if (kv && kv[2]) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, "");
  }
  return { meta, body: m[2] };
}

/** Title tokens, lowercased, punctuation stripped — the skill compares on these. */
function titleBigrams(title) {
  const tokens = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/[\s-]+/)
    .filter(Boolean);
  const grams = [];
  for (let i = 0; i + 1 < tokens.length; i++) grams.push(`${tokens[i]} ${tokens[i + 1]}`);
  return grams;
}

function hasPlaceholder(body) {
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    for (const [heading, placeholder] of PLACEHOLDERS) {
      if (lines[i].trim() !== heading) continue;
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j++;
      if (lines[j]?.trim() === placeholder) return true;
    }
  }
  return false;
}

function main() {
  const registry = JSON.parse(readFileSync(join(VAULT, "meta/registry.json"), "utf8"));
  const allIds = new Set(walk(WIKI).map((f) => f.slice(WIKI.length + 1).replace(/\.md$/, "")));

  // Out-links for every page in the vault, so in-link counts are correct even
  // when the inbound link comes from another repo's page.
  const outLinks = new Map();
  const inLinks = new Map();
  for (const id of allIds) {
    inLinks.set(id, 0);
  }
  const pageData = new Map();
  for (const id of allIds) {
    const raw = readFileSync(join(WIKI, `${id}.md`), "utf8");
    const { meta, body } = frontmatter(raw);
    const targets = new Set([
      ...[...body.matchAll(VAULT_LINK)].map((m) => m[1].replace(/^\//, "").replace(/\.md$/, "")),
      ...[...body.matchAll(WIKILINK)].map((m) => m[1]),
    ]);
    targets.delete(id);
    outLinks.set(id, targets);
    pageData.set(id, { meta, body, words: body.split(/\s+/).filter(Boolean).length });
    for (const t of targets) if (inLinks.has(t)) inLinks.set(t, inLinks.get(t) + 1);
  }

  const repoPages = [];
  for (const [id, entry] of Object.entries(registry.pages)) {
    const r = entry.repo;
    const repos = Array.isArray(r) ? r : typeof r === "string" && r ? r.split(",") : [];
    if (!repos.includes(repoFilter) || !allIds.has(id)) continue;
    const d = pageData.get(id);
    repoPages.push({
      id,
      type: entry.type ?? d.meta.type ?? "?",
      title: d.meta.title ?? id,
      words: d.words,
      out: outLinks.get(id).size,
      in: inLinks.get(id),
      created: entry.created ?? d.meta.created ?? null,
      placeholder: hasPlaceholder(d.body),
    });
  }

  const now = Date.now();
  const olderThanWindow = (created) =>
    !created || (now - Date.parse(created)) / 86400000 > ORPHAN_AGE_DAYS;

  // ── Pass A ────────────────────────────────────────────────────────────────
  const deletions = repoPages.filter((p) => p.in === 0 && p.out === 0 && olderThanWindow(p.created));
  const stubs = repoPages.filter(
    (p) => !deletions.includes(p) && (p.words < STUB_WORDS || (p.out === 0 && p.in > 0)),
  );
  const flaggedA = new Set([...deletions, ...stubs].map((p) => p.id));

  // ── Pass B ────────────────────────────────────────────────────────────────
  const byType = new Map();
  for (const p of repoPages) {
    if (flaggedA.has(p.id)) continue;
    if (!byType.has(p.type)) byType.set(p.type, []);
    byType.get(p.type).push(p);
  }
  const mergePairs = [];
  const prefixOnlyPairs = [];
  for (const [type, pages] of byType) {
    const grams = pages.map((p) => ({ p, g: new Set(titleBigrams(p.title)) }));
    for (let i = 0; i < grams.length; i++) {
      for (let j = i + 1; j < grams.length; j++) {
        const shared = [...grams[i].g].filter((g) => grams[j].g.has(g));
        if (shared.length === 0) continue;
        const pair = { type, a: grams[i].p, b: grams[j].p, shared };
        mergePairs.push(pair);
        // A shared bigram whose first token is the repo name is an artifact of
        // Semla's own entity namespacing, not evidence of a shared subject.
        if (shared.every((g) => g.startsWith(`${repoFilter} `))) prefixOnlyPairs.push(pair);
      }
    }
  }
  const flaggedB = new Set(mergePairs.flatMap((m) => [m.a.id, m.b.id]));

  // ── Pass C ────────────────────────────────────────────────────────────────
  const unflagged = repoPages.filter((p) => !flaggedA.has(p.id) && !flaggedB.has(p.id));
  const checkedC = Math.min(PASS_C_CAP, unflagged.length);

  const report = {
    repo: repoFilter,
    pages: repoPages.length,
    passA: {
      deletionCandidates: deletions.length,
      stubCandidates: stubs.length,
      stubRuleNote: `under ${STUB_WORDS} words, or in-links with no out-links`,
      combinedShareOfCorpus: +(((deletions.length + stubs.length) / repoPages.length) * 100).toFixed(1),
    },
    passB: {
      pagesReachingPassB: repoPages.length - flaggedA.size,
      candidatePairs: mergePairs.length,
      pairsSharingOnlyTheRepoPrefix: prefixOnlyPairs.length,
      pairsWithRealSharedBigram: mergePairs.length - prefixOnlyPairs.length,
    },
    passC: {
      pagesReachingPassC: unflagged.length,
      wouldBeChecked: checkedC,
      leftUnchecked: unflagged.length - checkedC,
    },
    step8: {
      pagesWithPlaceholderSections: repoPages.filter((p) => p.placeholder).length,
    },
    notAddressedByTheSkill:
      "No pass reads the repository. Passes A-C compare pages to other pages and step 8 removes literal placeholders, so nothing validates a cited src/ path — run scripts/audit-wiki-quality.mjs for that count.",
  };

  console.log(JSON.stringify(report, null, 2));

  if (listWhat === "b") {
    console.log("\nPass B candidate pairs (first 25):\n");
    for (const m of mergePairs.slice(0, 25)) {
      console.log(`  [${m.type}] ${m.a.title}`);
      console.log(`         + ${m.b.title}`);
      console.log(`         shared: ${m.shared.map((s) => `"${s}"`).join(", ")}`);
    }
  }

  if (listWhat === "a") {
    console.log("\nPass A deletion candidates (orphans):\n");
    for (const p of deletions) console.log(`  ${p.id}  (${p.words}w, in=${p.in}, out=${p.out})`);
  }
}

main();
