/**
 * Measure what pi-llm-wiki's per-turn auto-recall injection actually bought.
 *
 * The injection is a hidden tail message (`customType: "wiki-recall-context"`,
 * see src/lib/pi/wiki/wiki-recall-message.ts) carrying ranked wiki pages. In
 * links-first mode each entry also carries a literal `read <abs path>`
 * instruction, which is what makes consumption measurable at all: a later
 * tool call naming that exact path is unambiguous evidence the agent acted on
 * the injection, as opposed to merely having it in context.
 *
 * Three things are counted per injection, and the difference between them is
 * the whole point:
 *   - OFFERED  — pages injected, with the recall score the wiki assigned.
 *   - OPENED   — an injected path later appears in a `read` (or a `bash` that
 *                cats it) inside the same turn. Acted on.
 *   - DEEPENED — the agent called `wiki_recall`/`wiki_search` after the
 *                injection in that turn, i.e. it went looking for more.
 *
 * Turn attribution walks the file in append order rather than the parentId
 * tree, so a branched or superseded turn is attributed to whichever user
 * message preceded it on disk. Fine for aggregates, wrong for any single
 * branched session — see `--session` to inspect one directly.
 *
 * Usage:
 *   node scripts/analyze-wiki-recall.mjs
 *   node scripts/analyze-wiki-recall.mjs --session <id>
 *   node scripts/analyze-wiki-recall.mjs --json
 *   node scripts/analyze-wiki-recall.mjs --sweep     # pick minScore / repo filter
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const SESSION_DIR = process.env.PI_SESSION_DIR ?? ".semla-sessions";
const VAULT_REGISTRY = ".semla-wiki/.llm-wiki/meta/registry.json";
const RECALL_TYPE = "wiki-recall-context";
const SEARCH_TOOLS = new Set(["wiki_recall", "wiki_search"]);

/** Rough token estimate. Only ever compared against itself, so the constant matters less than its consistency. */
const CHARS_PER_TOKEN = 4;

const args = process.argv.slice(2);
const onlySession = args.includes("--session") ? args[args.indexOf("--session") + 1] : null;
const asJson = args.includes("--json");
const asSweep = args.includes("--sweep");

/**
 * page id -> repo names, from the vault registry. Absent when the vault is gone.
 *
 * `repo` is written either as an array or as a comma-joined string depending on
 * which version of the wiki stamped the page, so both are normalised here.
 */
function loadPageRepos() {
  if (!existsSync(VAULT_REGISTRY)) return new Map();
  const registry = JSON.parse(readFileSync(VAULT_REGISTRY, "utf8"));
  return new Map(
    Object.entries(registry.pages ?? {}).map(([id, page]) => {
      const repo = page.repo;
      if (Array.isArray(repo)) return [id, repo];
      if (typeof repo === "string" && repo) return [id, repo.split(",")];
      return [id, null];
    }),
  );
}

/**
 * Pull the offered pages out of one injection body.
 *
 * Handles both renderings in formatRecallContext: links-first numbered entries
 * carrying `score N.N`, and the preview-inline bullet list that has no score.
 * The `read` path is on its own continuation line in both.
 */
function parseInjection(content) {
  const pages = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const head = lines[i].match(/^\s*(?:\d+\.|-)\s+\*\*\[\[(.+?)\]\]\*\*\s+—\s+\*(.+?)\*(.*)$/);
    if (!head) continue;
    const [, id, type, rest] = head;
    const score = rest.match(/score\s+([\d.]+)/);
    // The read path may be one or two lines down (an inlined skill body pushes it).
    let path = null;
    for (let j = i + 1; j <= i + 2 && j < lines.length; j++) {
      const m = lines[j].match(/↳\s+`read\s+(.+?)`/);
      if (m) {
        path = m[1];
        break;
      }
    }
    pages.push({ id, type, score: score ? Number(score[1]) : null, path });
  }
  return pages;
}

/** Every string value anywhere in a tool call's arguments, for path matching. */
function argStrings(value, out = []) {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) argStrings(v, out);
  else if (value && typeof value === "object") for (const v of Object.values(value)) argStrings(v, out);
  return out;
}

function readSessionMeta(id) {
  const metaPath = join(SESSION_DIR, `${id}.json`);
  if (!existsSync(metaPath)) return {};
  try {
    return JSON.parse(readFileSync(metaPath, "utf8"));
  } catch {
    return {};
  }
}

/**
 * Walk one transcript, returning one record per recall injection.
 *
 * A turn is everything between two user messages. Consumption is only counted
 * within the injection's own turn: a path read three turns later is a different
 * decision, not this injection's effect.
 */
function analyzeSession(id) {
  const transcript = join(SESSION_DIR, `${id}.jsonl`);
  if (!existsSync(transcript)) return null;

  const entries = [];
  for (const line of readFileSync(transcript, "utf8").split("\n")) {
    if (!line) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // A truncated trailing line is normal for a session killed mid-write.
    }
  }

  const meta = readSessionMeta(id);
  const repos = (meta.projects ?? []).map((p) => p.path);
  const injections = [];
  let turnIndex = -1;
  let userTurns = 0;
  let open = null; // injection awaiting the rest of its turn

  const closeOpen = () => {
    if (open) injections.push(open);
    open = null;
  };

  for (const entry of entries) {
    const role = entry.message?.role;

    if (role === "user") {
      closeOpen();
      turnIndex++;
      userTurns++;
      continue;
    }

    if (entry.type === "custom_message" && entry.customType === RECALL_TYPE) {
      closeOpen();
      const content = entry.content ?? "";
      open = {
        sessionId: id,
        turnIndex,
        timestamp: entry.timestamp ?? null,
        chars: content.length,
        tokens: Math.round(content.length / CHARS_PER_TOKEN),
        linksFirst: content.includes("(links-first)"),
        offered: parseInjection(content),
        openedPages: [],
        mentionedPages: [],
        followUpSearches: [],
        toolCallsAfter: 0,
      };
      continue;
    }

    if (!open || role !== "assistant") continue;
    const blocks = entry.message?.content;
    if (!Array.isArray(blocks)) continue;

    for (const block of blocks) {
      // Weakest signal, and the only one available when a page is never opened:
      // the agent naming an offered page in prose. Evidence it read the
      // injected snippet, not evidence the page's content reached the answer.
      if (block.type === "text" && typeof block.text === "string") {
        for (const page of open.offered) {
          if (open.mentionedPages.includes(page.id)) continue;
          if (block.text.includes(page.id)) open.mentionedPages.push(page.id);
        }
        continue;
      }
      if (block.type !== "toolCall") continue;
      open.toolCallsAfter++;

      if (SEARCH_TOOLS.has(block.name)) {
        open.followUpSearches.push({
          tool: block.name,
          query: block.arguments?.query ?? null,
        });
        continue;
      }

      const strings = argStrings(block.arguments);
      for (const page of open.offered) {
        if (!page.path || open.openedPages.some((p) => p.id === page.id)) continue;
        if (strings.some((s) => s.includes(page.path))) {
          open.openedPages.push({ id: page.id, via: block.name, score: page.score });
        }
      }
    }
  }
  closeOpen();

  return { sessionId: id, title: meta.title ?? null, repos, userTurns, usage: meta.usage ?? null, injections };
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

/**
 * What raising `minScore`, and scoping to the session's repo, would have done
 * to the injections that actually happened.
 *
 * The score sweep is exact rather than an estimate. `searchWikiHybrid` ranks by
 * score and then takes the top `maxResults`, so a higher floor can only remove
 * pages from what we observed — there is nothing below the floor to backfill
 * with, and the pages above it kept their order.
 *
 * The repo column is *not* exact for the same reason, in the other direction. A
 * real repo filter would apply inside the search, before the top-3 cut, so it
 * would top each injection back up with lower-ranked same-repo pages. Read it
 * as what the filter removes, not as the volume a scoped run would produce:
 * scoping changes composition far more than it changes size.
 */
function sweep(withRecall, pageRepos, floors) {
  const rows = [];
  const baseOffered = withRecall.flatMap((s) => s.injections).flatMap((i) => i.offered).length;

  for (const floor of floors) {
    for (const scoped of [false, true]) {
      let offered = 0;
      let opened = 0;
      let crossRepo = 0;
      let injectionsLeft = 0;
      let tokens = 0;

      for (const session of withRecall) {
        for (const injection of session.injections) {
          const kept = injection.offered.filter((page) => {
            if (page.score !== null && page.score < floor) return false;
            if (!scoped) return true;
            const repos = pageRepos.get(page.id);
            // An untagged page cannot be shown to be off-repo, so a filter
            // keyed on the tag would keep it. Counted as kept, not dropped.
            if (!repos || repos.length === 0) return true;
            return session.repos.some((r) => repos.includes(r));
          });

          offered += kept.length;
          if (kept.length > 0) {
            injectionsLeft++;
            // Tokens scale with entries kept, since each is one ranked link.
            tokens += Math.round(injection.tokens * (kept.length / injection.offered.length || 0));
          }
          for (const hit of injection.openedPages) {
            if (kept.some((page) => page.id === hit.id)) opened++;
          }
          for (const page of kept) {
            const repos = pageRepos.get(page.id);
            if (repos && repos.length > 0 && !session.repos.some((r) => repos.includes(r))) {
              crossRepo++;
            }
          }
        }
      }

      rows.push({
        minScore: floor,
        repoScoped: scoped,
        offeredPages: offered,
        offeredRetainedPct: +((offered / (baseOffered || 1)) * 100).toFixed(1),
        openedPagesRetained: `${opened} of 16`,
        crossRepoPages: crossRepo,
        injectionsStillFiring: injectionsLeft,
        estTokens: tokens,
      });
    }
  }
  return rows;
}

function main() {
  const pageRepos = loadPageRepos();
  const ids = onlySession
    ? [onlySession]
    : [
        ...new Set(
          readdirSync(SESSION_DIR)
            .filter((f) => f.endsWith(".jsonl") && !f.endsWith(".spans.jsonl"))
            .map((f) => f.replace(/\.jsonl$/, "")),
        ),
      ];

  const sessions = [];
  for (const id of ids) {
    const result = analyzeSession(id);
    if (result) sessions.push(result);
  }

  const withRecall = sessions.filter((s) => s.injections.length > 0);
  const all = withRecall.flatMap((s) => s.injections);
  const offered = all.flatMap((i) => i.offered);
  const opened = all.flatMap((i) => i.openedPages);
  const deepened = all.filter((i) => i.followUpSearches.length > 0);
  const anyOpened = all.filter((i) => i.openedPages.length > 0);
  const anyMentioned = all.filter((i) => i.mentionedPages.length > 0);
  const inert = all.filter(
    (i) =>
      i.openedPages.length === 0 && i.mentionedPages.length === 0 && i.followUpSearches.length === 0,
  );

  // Relevance proxy: was the offered page even about a repo this session touches?
  let crossRepo = 0;
  let sameRepo = 0;
  let unknownRepo = 0;
  const offCounts = new Map();
  for (const session of withRecall) {
    for (const injection of session.injections) {
      for (const page of injection.offered) {
        const repos = pageRepos.get(page.id);
        if (!repos || repos.length === 0) {
          unknownRepo++;
          continue;
        }
        if (session.repos.some((r) => repos.includes(r))) sameRepo++;
        else {
          crossRepo++;
          for (const r of repos) offCounts.set(r, (offCounts.get(r) ?? 0) + 1);
        }
      }
    }
  }

  const scores = offered.map((p) => p.score).filter((s) => s !== null).sort((a, b) => a - b);
  const openedScores = opened.map((p) => p.score).filter((s) => s !== null);
  const tokens = all.reduce((sum, i) => sum + i.tokens, 0);
  const pageOfferCounts = new Map();
  for (const page of offered) pageOfferCounts.set(page.id, (pageOfferCounts.get(page.id) ?? 0) + 1);

  const report = {
    corpus: {
      sessionsWithTranscript: sessions.length,
      sessionsWithRecall: withRecall.length,
      injections: all.length,
      linksFirstInjections: all.filter((i) => i.linksFirst).length,
      userTurnsInRecallSessions: withRecall.reduce((n, s) => n + s.userTurns, 0),
    },
    offered: {
      pages: offered.length,
      distinctPages: pageOfferCounts.size,
      pagesPerInjection: +(offered.length / (all.length || 1)).toFixed(2),
      scoreMin: scores[0] ?? null,
      scoreP50: percentile(scores, 50),
      scoreP90: percentile(scores, 90),
      scoreMax: scores[scores.length - 1] ?? null,
    },
    consumed: {
      injectionsWithAnyPageOpened: anyOpened.length,
      openRateByInjection: +((anyOpened.length / (all.length || 1)) * 100).toFixed(1),
      pagesOpened: opened.length,
      openRateByPage: +((opened.length / (offered.length || 1)) * 100).toFixed(1),
      meanScoreOffered: scores.length
        ? +(scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(1)
        : null,
      meanScoreOpened: openedScores.length
        ? +(openedScores.reduce((a, b) => a + b, 0) / openedScores.length).toFixed(1)
        : null,
      injectionsWithAnyPageMentioned: anyMentioned.length,
      mentionRateByInjection: +((anyMentioned.length / (all.length || 1)) * 100).toFixed(1),
      inertInjections: inert.length,
      inertRate: +((inert.length / (all.length || 1)) * 100).toFixed(1),
    },
    deepened: {
      injectionsFollowedBySearch: deepened.length,
      rate: +((deepened.length / (all.length || 1)) * 100).toFixed(1),
      searchCalls: deepened.reduce((n, i) => n + i.followUpSearches.length, 0),
    },
    relevance: {
      offeredPagesSameRepo: sameRepo,
      offeredPagesCrossRepo: crossRepo,
      offeredPagesUnknownRepo: unknownRepo,
      crossRepoRate: +((crossRepo / (sameRepo + crossRepo || 1)) * 100).toFixed(1),
      topCrossRepoSources: [...offCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8),
    },
    cost: {
      injectedTokensEstimate: tokens,
      tokensPerInjection: Math.round(tokens / (all.length || 1)),
      note: "Input tokens per turn, re-sent on every subsequent turn of the same conversation.",
    },
    mostOfferedPages: [...pageOfferCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12),
  };

  if (asJson) {
    console.log(JSON.stringify({ report, sessions: withRecall }, null, 2));
    return;
  }

  if (asSweep) {
    console.log(
      `Baseline: ${all.length} injections, ${offered.length} offered pages, ` +
        `${opened.length} opened, ${crossRepo} cross-repo, ~${tokens} tokens.\n`,
    );
    console.table(sweep(withRecall, pageRepos, [5, 20, 40, 55, 70, 85, 105]));
    return;
  }

  console.log(JSON.stringify(report, null, 2));

  if (onlySession && withRecall.length > 0) {
    console.log("\nPer-injection detail:");
    for (const injection of withRecall[0].injections) {
      console.log(
        `\n  turn ${injection.turnIndex} — ${injection.offered.length} offered, ` +
          `${injection.openedPages.length} opened, ${injection.followUpSearches.length} follow-up searches, ` +
          `~${injection.tokens} tok`,
      );
      for (const page of injection.offered) {
        const hit = injection.openedPages.find((p) => p.id === page.id);
        console.log(`    ${hit ? "OPENED " : "ignored"} [${page.score ?? "-"}] ${page.id}`);
      }
    }
  }
}

main();
