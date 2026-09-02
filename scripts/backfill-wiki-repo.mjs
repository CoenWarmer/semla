#!/usr/bin/env node
// Backfill repo: field into wiki pages and registry for pages that lack it.
// Usage: node scripts/backfill-wiki-repo.mjs <repo-slug>
// Example: node scripts/backfill-wiki-repo.mjs semla

import { readFileSync, writeFileSync, readdirSync } from "fs";
import { join } from "path";

const repo = process.argv[2];
if (!repo) {
  console.error("Usage: node scripts/backfill-wiki-repo.mjs <repo-slug>");
  process.exit(1);
}

const WIKI_HOME = process.env.WIKI_HOME ?? join(process.cwd(), ".semla-wiki");
const WIKI_ROOT = join(WIKI_HOME, ".llm-wiki");
const WIKI_DIR = join(WIKI_ROOT, "wiki");
const REGISTRY_PATH = join(WIKI_ROOT, "meta", "registry.json");

// ── Patch frontmatter files ────────────────────────────────────────────────

const subdirs = ["entities", "concepts", "sources", "analyses", "syntheses", "requirements"];
let patchedFiles = 0;

for (const sub of subdirs) {
  const dir = join(WIKI_DIR, sub);
  let files;
  try { files = readdirSync(dir); } catch { continue; }

  for (const file of files) {
    if (!file.endsWith(".md") || file === "index.md") continue;
    const path = join(dir, file);
    const content = readFileSync(path, "utf-8");

    // Skip pages that already have repo:
    if (/^repo:/m.test(content)) continue;

    // Insert repo: after the last frontmatter field before closing ---
    const patched = content.replace(
      /^(---\n[\s\S]*?)(---)/m,
      (_, front, close) => `${front}repo: ${repo}\n${close}`,
    );

    if (patched !== content) {
      writeFileSync(path, patched, "utf-8");
      patchedFiles++;
    }
  }
}

// ── Patch registry.json ────────────────────────────────────────────────────

let patchedRegistry = 0;
try {
  const registry = JSON.parse(readFileSync(REGISTRY_PATH, "utf-8"));
  for (const [, meta] of Object.entries(registry.pages ?? {})) {
    if (!meta.repo) {
      meta.repo = repo;
      patchedRegistry++;
    }
  }
  writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2), "utf-8");
} catch (e) {
  console.warn("Could not patch registry.json:", e.message);
}

console.log(`Done. Patched ${patchedFiles} file(s) and ${patchedRegistry} registry entry(ies) with repo: ${repo}`);
