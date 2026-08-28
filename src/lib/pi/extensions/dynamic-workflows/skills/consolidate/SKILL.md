---
name: consolidate
description: Audit wiki pages for isolation, fragmentation, and redundancy across three dimensions, then propose and (after approval) apply merges, deletions, and expansions.
---

# Consolidate: multi-dimensional wiki consolidation

`consolidate` audits the wiki, produces a human-readable proposal, and—after approval—applies the changes. It runs three passes in order; each reduces noise for the next.

## When to invoke

- Explicitly requested: "consolidate the wiki", `/consolidate`
- Proactively after repeated `/orient` or `/wiki-ingest` runs when `wiki_status` shows high page count with low link density

---

## Three dimensions

| Pass | Dimension | Detects | Cost |
|------|-----------|---------|------|
| A | Topological | Orphans (no links in or out), stubs (thin content) | Free — graph math |
| B | Structural | Type fragmentation — several pages of the same type covering the same subject | Low — title heuristics + backlink overlap |
| C | Semantic | Near-duplicates — differently-named pages with substantially the same content | Medium — `wiki_recall` per page |

Run A first; its results gate B (skip already-flagged pages); B results gate C (skip already-flagged pages). Do **not** apply any changes before the proposal is approved.

---

## Steps

### 1. Baseline

Call `wiki_status` and `wiki_lint` (auto_fix: false). Record:
- Total pages per type
- Orphan paths from lint output
- Broken-link list from lint output

### 2. Pass A — Topological

From the lint output classify each orphan:

- **Deletion candidate**: zero in-links AND zero out-links AND created more than 7 days ago
- **Stub candidate**: content under ~200 words OR zero out-links but has in-links (referenced but thin)

### 3. Pass B — Structural

For each page type (`entity`, `concept`, `analysis`, `synthesis`, `requirement`), use the `workflow` tool to run type checks in parallel if available; otherwise run sequentially.

Within each type:
1. Call `wiki_search` with `type` set to that type to get all pages of that type.
2. Compare titles pairwise for **n-gram overlap**: extract 2-token sequences from each title; if two titles share ≥ 1 bigram, treat them as a candidate pair.
3. For each candidate pair, read both pages (file at `$WIKI_HOME/.llm-wiki/wiki/{path}.md`). If they share named entities or concepts in their first two paragraphs, flag as a **merge candidate**.
4. Skip pages already flagged in Pass A.

### 4. Pass C — Semantic

For pages not flagged in passes A or B, run `wiki_recall` with each page's title as the query (limit 3 results). If the top result is a *different* page with high similarity:
- Flag the pair as a **near-duplicate candidate**
- Note which copy is more complete (longer, more out-links)

Limit Pass C to at most 20 pages to keep cost predictable. If the wiki has more un-flagged pages, prioritise `entity` and `concept` types, then note the remainder was not checked.

### 5. Proposal

Group findings and present them to the user. Use this format:

```
## Consolidation Proposal

### A — Deletions (topological orphans)
- `entities/foo-bar` — no in-links, no out-links, created 2025-01-10
  Action: delete

### B — Merges (structural fragmentation)
- `entities/auth-service` + `entities/authentication-service` → keep `entities/auth-service`
  Reason: shared bigram "auth service"; both pages reference AuthToken and Session
  Action: merge content, delete `entities/authentication-service`, repoint its links

### C — Near-duplicates (semantic)
- `concepts/rate-limiting` ≈ `concepts/throttling` (high recall similarity)
  Recommendation: merge into `concepts/rate-limiting` (more backlinks)
  Action: merge content, delete `concepts/throttling`

### Stubs to expand
- `concepts/circuit-breaker` — 90 words, zero out-links
  Action: expand using `wiki_recall` on "circuit breaker"
```

Ask: **"Approve all, approve by section (A / B / C / stubs), skip, or modify?"**

Do not proceed until the user responds.

### 6. Apply approved changes

Work through each approved action in this order: deletions → merges → expansions. Call `wiki_rebuild_meta` **once** after all changes, not after each file.

#### Deletion
1. Delete the `.md` file from `$WIKI_HOME/.llm-wiki/wiki/{path}.md`.

#### Merge
1. Read both pages.
2. Write merged content into the surviving page: combine unique facts, keep the better prose structure, preserve all out-links from both pages.
3. Delete the absorbed page's `.md` file.
4. Find all pages that link to the absorbed path (`[[absorbed-title]]` or `[text](/absorbed/path.md)`) and update them to point to the survivor.

#### Expansion
1. Call `wiki_recall` with the stub's title to surface related content.
2. Rewrite the stub page with at least 300 words of factual content drawn from related pages. Do not fabricate.

After all file changes, call `wiki_rebuild_meta` to rebuild the registry and backlinks.

### 7. Log and report

Call `wiki_log_event` with `kind: "consolidate"` and `details` containing:
- `deleted`: number
- `merged`: number
- `expanded`: number
- `unchecked_semantic`: number (pages skipped in Pass C due to the 20-page cap)

Report a one-paragraph summary of what changed.
