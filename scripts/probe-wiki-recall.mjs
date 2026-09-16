/**
 * Show what the two rankers disagree about, page by page.
 *
 * The aggregate replay in `tune-wiki-recall.mjs` measures against the pages the
 * agent opened, and that ground truth is selection-biased by construction: the
 * offers it was drawn from were ranked lexically, so a page only semantic
 * search would surface was never offered and could never have been opened. A
 * flat hit rate therefore cannot distinguish "semantics adds nothing" from
 * "semantics adds things this corpus cannot see".
 *
 * This prints the disagreement instead — for each sampled prompt, the pages
 * only lexical ranks in the top 3, and the pages only the hybrid does — so the
 * question can be answered by reading them.
 *
 * Usage:
 *   node scripts/probe-wiki-recall.mjs
 *   node scripts/probe-wiki-recall.mjs --sample 12 --weight 0.5
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createJiti } from "jiti";

const root = process.cwd();
const arg = (flag, fallback) => {
  const i = process.argv.indexOf(flag);
  return i === -1 ? fallback : process.argv[i + 1];
};
const sampleSize = Number(arg("--sample", 10));
const weight = Number(arg("--weight", 0.5));

const jiti = createJiti(import.meta.url, {
  alias: { "@": join(root, "src") },
  interopDefault: true,
});
const PACKAGE = join(root, "node_modules/@zosmaai/pi-llm-wiki/extensions/llm-wiki/lib");

const { isolatePiAgentDir } = await jiti.import("@/lib/pi/runtime/agent-dir");
isolatePiAgentDir();
const { configureWikiEmbeddings } = await jiti.import("@/lib/pi/wiki/wiki-embedding-config");
if (!configureWikiEmbeddings().configured) {
  console.error("No embedding credential; there is no hybrid arm to compare.");
  process.exit(1);
}

const { WIKI_HOME } = await jiti.import("@/lib/pi/runtime/runtime-config");
const { loadTaskConfig } = await jiti.import(join(PACKAGE, "task-config.ts"));
const { getVaultPaths } = await jiti.import(join(PACKAGE, "utils.ts"));
const { searchWikiHybrid, searchWikiLayered } = await jiti.import(join(PACKAGE, "recall.ts"));

const paths = getVaultPaths(WIKI_HOME);
const config = { ...loadTaskConfig(WIKI_HOME), semanticWeight: weight };
const registry = JSON.parse(readFileSync(join(paths.meta, "registry.json"), "utf8"));

const pageRepos = new Map(
  Object.entries(registry.pages ?? {}).map(([id, page]) => {
    const repo = page.repo;
    if (Array.isArray(repo)) return [id, repo];
    if (typeof repo === "string" && repo) return [id, repo.split(",")];
    return [id, null];
  }),
);

/** Prompts that actually triggered a recall, newest sessions first. */
function collectPrompts() {
  const out = [];
  const dir = ".semla-sessions";
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".jsonl") || file.includes(".spans")) continue;
    const id = file.replace(/\.jsonl$/, "");
    if (!existsSync(join(dir, `${id}.json`))) continue;
    let meta;
    try {
      meta = JSON.parse(readFileSync(join(dir, `${id}.json`), "utf8"));
    } catch {
      continue;
    }
    const repos = (meta.projects ?? []).map((p) => p.path).filter(Boolean);
    if (repos.length === 0) continue;

    let prompt = null;
    for (const line of readFileSync(join(dir, file), "utf8").split("\n")) {
      if (!line) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry.message?.role === "user") {
        const content = entry.message.content;
        prompt =
          typeof content === "string"
            ? content
            : Array.isArray(content)
              ? content.filter((b) => b.type === "text").map((b) => b.text).join(" ")
              : "";
        continue;
      }
      if (entry.type === "custom_message" && entry.customType === "wiki-recall-context" && prompt) {
        out.push({ prompt, repos });
      }
    }
  }
  return out;
}

const all = collectPrompts();
// Spread the sample across the corpus rather than taking a contiguous run of
// one session's turns, which would all share a topic.
const step = Math.max(1, Math.floor(all.length / sampleSize));
const sample = all.filter((_, i) => i % step === 0).slice(0, sampleSize);

const label = (hit, repos) => {
  const owner = pageRepos.get(hit.id);
  const cross = owner && owner.length > 0 && !repos.some((r) => owner.includes(r));
  return `${cross ? "✗" : "·"} ${hit.score.toFixed(1).padStart(6)}  ${hit.id}${
    cross ? `   [${owner.join("+")}]` : ""
  }`;
};

console.log(
  `Comparing lexical against hybrid (semanticWeight ${weight}) on ${sample.length} prompts.\n` +
    "  ✗ marks a page belonging to a repository the session was not working in.\n" +
    `${"=".repeat(100)}`,
);

let agreed = 0;
let lexCross = 0;
let hybCross = 0;
let slots = 0;

for (const { prompt, repos } of sample) {
  const lexical = (await searchWikiLayered(paths, prompt, 3, 0, false)).slice(0, 3);
  const hybrid = (await searchWikiHybrid(paths, prompt, 3, 0, false, { config })).slice(0, 3);

  const lexIds = new Set(lexical.map((h) => h.id));
  const hybIds = new Set(hybrid.map((h) => h.id));
  const same = lexical.length === hybrid.length && lexical.every((h, i) => h.id === hybrid[i].id);
  if (same) agreed += 1;

  slots += hybrid.length;
  for (const h of lexical) {
    const owner = pageRepos.get(h.id);
    if (owner && owner.length > 0 && !repos.some((r) => owner.includes(r))) lexCross += 1;
  }
  for (const h of hybrid) {
    const owner = pageRepos.get(h.id);
    if (owner && owner.length > 0 && !repos.some((r) => owner.includes(r))) hybCross += 1;
  }

  if (same) continue;

  console.log(`\nPROMPT: "${prompt.slice(0, 140).replace(/\s+/g, " ")}"`);
  console.log(`  repos: ${repos.map((r) => r.split("/").pop()).join(", ")}`);
  console.log("  lexical only:");
  const lexOnly = lexical.filter((h) => !hybIds.has(h.id));
  const hybOnly = hybrid.filter((h) => !lexIds.has(h.id));
  for (const h of lexOnly) console.log(`    ${label(h, repos)}`);
  if (lexOnly.length === 0) console.log("    (none — same pages, different order)");
  console.log("  hybrid only:");
  for (const h of hybOnly) console.log(`    ${label(h, repos)}`);
  if (hybOnly.length === 0) console.log("    (none — same pages, different order)");
}

console.log(`\n${"=".repeat(100)}`);
console.log(
  `Identical top 3 on ${agreed}/${sample.length} prompts. ` +
    `Cross-repo slots: lexical ${lexCross}, hybrid ${hybCross}, of ${slots}.`,
);
