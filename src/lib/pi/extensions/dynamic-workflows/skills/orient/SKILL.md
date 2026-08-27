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

Use the `workflow` tool to spawn parallel subagents, each capturing a different facet:

| Subagent | Sources to capture |
|---|---|
| Overview | README.md, AGENTS.md, CLAUDE.md — any top-level `.md` files |
| Dependencies | package.json / requirements.txt / go.mod / Cargo.toml / pyproject.toml |
| Structure | Directory tree (`find . -maxdepth 3 -not -path '*/node_modules/*' -not -path '*/.git/*'`), main config files |
| Conventions | tsconfig.json, eslint config, test setup |
| History | `git log --oneline -30` |

Each subagent uses `wiki_capture_source` to add its content to the wiki vault.

If the `workflow` tool is unavailable, capture the sources sequentially yourself.

### 5. Ingest

```
/wiki-ingest
```

This synthesises the captured sources into structured wiki pages (entities, concepts, analyses) with cross-links.

### 6. Report

Call `wiki_recall` once more with the repo name and report a one-paragraph summary of the key pages now available.
