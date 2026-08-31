---
name: orient
description: Initialise the pi-llm-wiki knowledge base for a code repository. Use when asked to orient yourself on a repo, or when wiki_recall returns no results for the active project.
---

# Orient: bootstrap codebase knowledge in the wiki

`orient` initialises and populates the wiki for a repository so that future sessions start with structured codebase knowledge. It uses pi-llm-wiki's ingest pipeline rather than writing flat files.

## When to invoke

- Explicitly requested: "orient yourself", "learn this codebase", `/orient`
- Automatically: the system prompt will tell you when `wiki_recall` returns no results for the active project

## Steps

### 1. Confirm the target

Default to the current working directory. Accept an explicit path if the user provides one.

### 2. Check for existing wiki knowledge

Call `wiki_recall` with the repo name (e.g. `kibana`, `semla`). If it returns relevant pages the wiki is already populated — summarise what you found and stop.

### 3. Initialise the wiki if needed

```
/wiki-init {repo-name}
```

This creates the vault structure under `$WIKI_HOME/.llm-wiki/`.

### 4. Capture sources in parallel

Use the `workflow` tool to spawn parallel subagents, each capturing a different facet.

Subagents have the wiki tools by default, so each one can capture its own facet. Do not
collect text in subagents and capture it yourself afterwards — that serialises the work you
just parallelised.

| Subagent | Sources to capture |
|---|---|
| Overview | README.md, AGENTS.md, CLAUDE.md — any top-level `.md` files |
| Dependencies | package.json / requirements.txt / go.mod / Cargo.toml / pyproject.toml |
| Structure | Directory tree (`find . -maxdepth 3 -not -path '*/node_modules/*' -not -path '*/.git/*'`), main config files |
| Conventions | tsconfig.json, eslint config, test setup |
| History | `git log -n 40 --format='%h %s%n%b%n---'` — **with bodies**, see below |
| Design notes | `docs/`, `adr/`, `rfcs/`, `*.md` design or plan files outside the top level |
| Review discussion | Merged PR titles and bodies via `gh pr list --state merged --limit 30 --json number,title,body` (skip if `gh` is unavailable or unauthenticated) |

**Pass what you read as `text`, with a `title`. Never as `url`.** You are
capturing files from a local checkout. `url` is first in the tool's parameter
list, so a subagent given no steer reaches for it, and the package then runs its
*web* extractor over whatever it was handed — one run stored
"Content could not be extracted" for a repo path, another captured a GitHub 404
page as a source. `url` is only for a genuine web page; `file_path` captures a
single file as-is.

**Do not fetch from GitHub for anything that is in the checkout.** The code,
the README and the git history are all on disk and are the authority. `gh` is
for the Review discussion facet only, where the content exists nowhere locally.

**Capture commit bodies, not just subjects.** `git log --oneline` throws away the
message body, which is usually the only written record of *why* a change was
made. A subject line yields "added a vault lock"; the body yields "two captures
that both list the directory before either writes get the same id, and the
second silently overwrites the first". The first is a fact you could have read
off the code, the second is a decision you could not.

Keep History and Design notes as their own facets rather than folding them into
Overview: bodies for 40 commits are a large blob, and mixing them into another
source dilutes both.

Each subagent calls `wiki_capture_source` itself and reports back only the source ID — never
the captured text.

`wiki_ingest` is deliberately withheld from subagents, since it starts a background run of
its own. Run it yourself in step 5, once the capture workflow has finished.

If the `workflow` tool is unavailable, capture the sources sequentially yourself.

### 5. Ingest

```
/wiki-ingest
```

This synthesises the captured sources into structured wiki pages (entities, concepts) with cross-links.

### 6. Record the decisions

Ingest produces `entity` and `concept` pages only — one-line answers to *what a
thing is*. The reasoning behind the code has no page of its own unless you write
one.

Re-read the History and Design notes sources and, for each decision that is
still load-bearing, create an `analysis` page:

```
wiki_ensure_page(type: "analysis", title: "...", content: "...")
```

`content` is the **body only** — start at the first `##` heading. The tool writes
the frontmatter itself, so including a `---` block of your own leaves the page
with two of them, and only the first is ever parsed.

Each page should say what was chosen, **what it was chosen over**, and the
constraint that forced it. A decision with no alternative and no constraint is
just a description — leave it to the concept pages.

Aim for the handful that would change how someone edits the code. Skip anything
that is merely a description of current behaviour, and skip decisions that have
since been reversed unless the reversal is itself instructive.

### 7. Report

Call `wiki_recall` once more with the repo name and report a one-paragraph summary of the key pages now available.
