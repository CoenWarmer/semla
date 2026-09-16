/**
 * Replay every historical recall against the live vault, with semantics on.
 *
 * The corpus in `.semla-sessions` records what the ranker offered and — by
 * matching each offered page's path against the tool calls that followed — what
 * the agent actually opened. Those opens are the only ground truth available
 * about which pages were worth injecting, so they are the target here: a better
 * ranker is one that puts them in the top 3 more often, and puts pages from
 * other repositories there less often.
 *
 * The package does the scoring, through jiti, so the variants compared are the
 * real code paths rather than a reimplementation that could agree with itself
 * and not with production. `searchWikiLayered` with no semantic context is the
 * lexical-only arm; `searchWikiHybrid` with a `semanticWeight` is the hybrid
 * arm. minScore is 0 in every arm — the floor is applied afterwards, here, so
 * one pass can report every floor at once.
 *
 * Usage:
 *   node scripts/tune-wiki-recall.mjs
 *   node scripts/tune-wiki-recall.mjs --limit 50    # quick pass
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createJiti } from "jiti";

const root = process.cwd();
const limitArg = process.argv.indexOf("--limit");
const limit = limitArg === -1 ? Infinity : Number(process.argv[limitArg + 1]);

const jiti = createJiti(import.meta.url, {
  alias: { "@": join(root, "src") },
  interopDefault: true,
});
const PACKAGE = join(root, "node_modules/@zosmaai/pi-llm-wiki/extensions/llm-wiki/lib");

const { isolatePiAgentDir } = await jiti.import("@/lib/pi/runtime/agent-dir");
isolatePiAgentDir();
const { configureWikiEmbeddings } = await jiti.import("@/lib/pi/wiki/wiki-embedding-config");
const setup = configureWikiEmbeddings();
if (!setup.configured) {
  console.error("No embedding credential; nothing to compare against lexical.");
  process.exit(1);
}

const { WIKI_HOME } = await jiti.import("@/lib/pi/runtime/runtime-config");
const { loadTaskConfig } = await jiti.import(join(PACKAGE, "task-config.ts"));
const { getVaultPaths } = await jiti.import(join(PACKAGE, "utils.ts"));
const { searchWikiHybrid, searchWikiLayered } = await jiti.import(join(PACKAGE, "recall.ts"));

const paths = getVaultPaths(WIKI_HOME);
const baseConfig = loadTaskConfig(WIKI_HOME);

// ── the corpus ────────────────────────────────────────────

const SESSIONS = ".semla-sessions";
const registry = JSON.parse(readFileSync(join(paths.meta, "registry.json"), "utf8"));

const pageRepos = new Map(
  Object.entries(registry.pages ?? {}).map(([id, page]) => {
    const repo = page.repo;
    if (Array.isArray(repo)) return [id, repo];
    if (typeof repo === "string" && repo) return [id, repo.split(",")];
    return [id, null];
  }),
);

function parseInjection(content) {
  const offered = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const head = lines[i].match(/^\s*(?:\d+\.|-)\s+\*\*\[\[(.+?)\]\]\*\*\s+—\s+\*(.+?)\*(.*)$/);
    if (!head) continue;
    let path = null;
    for (let j = i + 1; j <= i + 2 && j < lines.length; j++) {
      const m = lines[j].match(/↳\s+`read\s+(.+?)`/);
      if (m) {
        path = m[1];
        break;
      }
    }
    offered.push({ id: head[1], path });
  }
  return offered;
}

function argStrings(value, out = []) {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) argStrings(v, out);
  else if (value && typeof value === "object") for (const v of Object.values(value)) argStrings(v, out);
  return out;
}

/** Every prompt that triggered a recall, with the repos it ran in and what it opened. */
function collectTurns() {
  const turns = [];
  for (const file of readdirSync(SESSIONS)) {
    if (!file.endsWith(".jsonl") || file.includes(".spans")) continue;
    const id = file.replace(/\.jsonl$/, "");
    const metaPath = join(SESSIONS, `${id}.json`);
    if (!existsSync(metaPath)) continue;
    let meta;
    try {
      meta = JSON.parse(readFileSync(metaPath, "utf8"));
    } catch {
      continue;
    }
    const repos = (meta.projects ?? []).map((p) => p.path).filter(Boolean);
    if (repos.length === 0) continue;

    const entries = [];
    for (const line of readFileSync(join(SESSIONS, file), "utf8").split("\n")) {
      if (!line) continue;
      try {
        entries.push(JSON.parse(line));
      } catch {}
    }

    let prompt = null;
    let open = null;
    const close = () => {
      if (open && open.prompt) turns.push({ ...open, repos, session: id });
      open = null;
    };

    for (const entry of entries) {
      if (entry.message?.role === "user") {
        close();
        const content = entry.message.content;
        prompt =
          typeof content === "string"
            ? content
            : Array.isArray(content)
              ? content.filter((b) => b.type === "text").map((b) => b.text).join(" ")
              : "";
        continue;
      }
      if (entry.type === "custom_message" && entry.customType === "wiki-recall-context") {
        close();
        open = { prompt, offered: parseInjection(entry.content ?? ""), opened: new Set() };
        continue;
      }
      if (!open || entry.message?.role !== "assistant") continue;
      const blocks = entry.message?.content;
      if (!Array.isArray(blocks)) continue;
      for (const block of blocks) {
        if (block.type !== "toolCall") continue;
        const strings = argStrings(block.arguments);
        for (const page of open.offered) {
          if (page.path && strings.some((s) => s.includes(page.path))) open.opened.add(page.id);
        }
      }
    }
    close();
  }
  return turns;
}

// ── the arms ──────────────────────────────────────────────

const CANDIDATES = 12;

/**
 * Weights above 1 are the point of this sweep, and are reachable only from here:
 * `readNamespacedConfig` clamps the setting to [0,1], but `searchWikiHybrid`
 * reads `opts.config.semanticWeight` without re-clamping, so a config passed
 * directly explores the range the settings file cannot express.
 *
 * They are also how normalisation is measured without patching anything.
 * Dividing the lexical score by the query's term count is a per-query constant,
 * so it cannot reorder a single result — its whole effect on ranking is to
 * multiply the semantic term's relative share by that count. A fixed weight of
 * `w` is therefore the same family of rankings as normalised-with-weight
 * `w / terms.length`, which is what makes the sweep informative about a change
 * that has not been written yet.
 */
const weightArg = process.argv.indexOf("--weights");
const WEIGHTS =
  weightArg === -1 ? [0.5, 2, 5, 10, 25] : process.argv[weightArg + 1].split(",").map(Number);

const ARMS = [
  {
    name: "lexical (today)",
    run: (prompt) => searchWikiLayered(paths, prompt, CANDIDATES, 0, false),
  },
  ...WEIGHTS.map((weight) => ({
    name: `hybrid w=${weight}`,
    run: (prompt) =>
      searchWikiHybrid(paths, prompt, CANDIDATES, 0, false, {
        config: { ...baseConfig, semanticWeight: weight },
      }),
  })),
];

function isCrossRepo(id, repos) {
  const owner = pageRepos.get(id);
  if (!owner || owner.length === 0) return false;
  return !repos.some((r) => owner.includes(r));
}

const turns = collectTurns().filter((t) => t.opened.size > 0 || t.offered.length > 0);
const withOpens = turns.filter((t) => t.opened.size > 0);
console.log(
  `Corpus: ${turns.length} recalls across ${new Set(turns.map((t) => t.session)).size} sessions, ` +
    `${withOpens.length} of them with at least one page the agent opened.\n`,
);

const sample = turns.slice(0, Number.isFinite(limit) ? limit : turns.length);
const results = new Map(
  ARMS.map((a) => [
    a.name,
    {
      top3: 0,
      opens: 0,
      cross: 0,
      slots: 0,
      scores: [],
      scopedTop3: 0,
      scopedSlots: 0,
      scopedScores: [],
      perRecallTop: [],
    },
  ]),
);

let done = 0;
for (const turn of sample) {
  for (const arm of ARMS) {
    let ranked;
    try {
      ranked = await arm.run(turn.prompt);
    } catch (error) {
      console.error(`  ${arm.name} failed on a prompt: ${error.message}`);
      continue;
    }
    const top3 = ranked.slice(0, 3);
    // The repo filter already shipped, so every arm is also measured behind it:
    // scoping the 12 candidates first is what production now does.
    const scopedTop3 = ranked.filter((h) => !isCrossRepo(h.id, turn.repos)).slice(0, 3);
    const acc = results.get(arm.name);
    acc.slots += top3.length;
    acc.scopedSlots += scopedTop3.length;
    for (const hit of top3) {
      if (isCrossRepo(hit.id, turn.repos)) acc.cross += 1;
      acc.scores.push(hit.score);
    }
    for (const hit of scopedTop3) acc.scopedScores.push(hit.score);
    acc.perRecallTop.push(scopedTop3.length > 0 ? scopedTop3[0].score : 0);
    // Did this arm surface the pages the agent chose to read?
    for (const openedId of turn.opened) {
      acc.opens += 1;
      if (top3.some((h) => h.id === openedId)) acc.top3 += 1;
      if (scopedTop3.some((h) => h.id === openedId)) acc.scopedTop3 += 1;
    }
  }
  done += 1;
  if (done % 25 === 0) process.stderr.write(`  ...${done}/${sample.length} recalls replayed\n`);
}

// ── report ────────────────────────────────────────────────

const median = (a) => {
  if (a.length === 0) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};

console.log("\nRanking quality, top 3 per recall:\n");
console.table(
  ARMS.map((arm) => {
    const r = results.get(arm.name);
    return {
      arm: arm.name,
      "opened in top 3": `${r.top3}/${r.opens}`,
      "opened in top 3, scoped": `${r.scopedTop3}/${r.opens}`,
      "cross-repo share": `${((100 * r.cross) / Math.max(1, r.slots)).toFixed(0)}%`,
      "median score": median(r.scores).toFixed(1),
      "max score": Math.max(0, ...r.scores).toFixed(1),
    };
  }),
);

const floorArg = process.argv.indexOf("--floors");
const FLOORS =
  floorArg === -1 ? [5, 10, 20, 40] : process.argv[floorArg + 1].split(",").map(Number);

console.log("\nWhat a floor would keep, per arm (share of scoped top-3 slots surviving):\n");
console.table(
  ARMS.map((arm) => {
    const r = results.get(arm.name);
    const row = { arm: arm.name };
    for (const floor of FLOORS) {
      const kept = r.scopedScores.filter((s) => s >= floor).length;
      row[`>=${floor}`] = `${((100 * kept) / Math.max(1, r.scopedScores.length)).toFixed(0)}%`;
    }
    return row;
  }),
);

// The floor also decides whether a recall fires at all: with the cap at three,
// its dominant effect is emptying injections, not shortening them. That is the
// number that matters for a corpus where 91% of injections went unread.
console.log("\nRecalls that would still fire at all, per arm:\n");
console.table(
  ARMS.map((arm) => {
    const r = results.get(arm.name);
    const row = { arm: arm.name };
    for (const floor of FLOORS) {
      const firing = r.perRecallTop.filter((top) => top >= floor).length;
      row[`>=${floor}`] =
        `${firing}/${r.perRecallTop.length} (${((100 * firing) / Math.max(1, r.perRecallTop.length)).toFixed(0)}%)`;
    }
    return row;
  }),
);

console.log("\nScored percentiles of the scoped top-3 slots:\n");
console.table(
  ARMS.map((arm) => {
    const s = [...results.get(arm.name).scopedScores].sort((a, b) => a - b);
    const q = (p) => (s.length === 0 ? 0 : s[Math.min(s.length - 1, Math.floor(p * s.length))]);
    return {
      arm: arm.name,
      p10: q(0.1).toFixed(1),
      p25: q(0.25).toFixed(1),
      median: q(0.5).toFixed(1),
      p75: q(0.75).toFixed(1),
      p90: q(0.9).toFixed(1),
    };
  }),
);
