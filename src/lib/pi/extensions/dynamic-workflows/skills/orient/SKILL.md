---
name: orient
description: Scan a code repository and write a persistent codebase memory file to $SEMLA_MEMORIES_DIR. Invoke when asked to orient yourself on a repo, or when the system prompt says no memory exists for the current project.
---

# Orient: generate codebase memory

`orient` scans a repository and writes a structured memory file that bootstraps future agent sessions. Once written, the memory is automatically injected into the Semla system prompt so future sessions start with full context.

## Determine the target

Default to the current working directory. Accept an explicit path as an argument if the user provides one (e.g. `/orient /Users/coen/Dev/kibana`).

## Compute the memory file path

1. Get the absolute path of the target repo.
2. Derive the slug: strip the leading `/`, then replace every non-alphanumeric character with `_`.
   Example: `/Users/coen/Dev/kibana` → `Users_coen_Dev_kibana`
3. The memory file path is `$SEMLA_MEMORIES_DIR/{slug}.md`.

Run `echo $SEMLA_MEMORIES_DIR` in bash to confirm the resolved directory.

## Scan the repository

Use the `workflow` tool to scan in parallel. Assign one subagent per facet below — each reads only what it needs and returns a concise structured summary.

| Facet | What to read |
|---|---|
| Overview | README.md, AGENTS.md, CLAUDE.md, any top-level `.md` files |
| Dependencies | package.json / requirements.txt / go.mod / Cargo.toml / pyproject.toml — list the key packages and what they do in this project |
| Structure | Directory tree to depth 3; identify the main source dirs, entry points, and config files |
| Conventions | tsconfig.json / eslint config / .prettierrc / test setup — note patterns, naming conventions, anything that would surprise a newcomer |
| Recent history | `git log --oneline -20` — summarise the recent direction of work |

If the `workflow` tool is not available, run the facets sequentially yourself.

## Write the memory file

First create the directory: `mkdir -p $SEMLA_MEMORIES_DIR`

Then write the memory file in this format:

```markdown
# {project-name} — Codebase Memory
Generated: {ISO date}
Path: {absolute repo path}

## Stack
One-liner: language, framework, runtime, test runner.

## Key dependencies
- `{package}`: what it does in this project

## Architecture
2–3 sentences describing how the codebase is structured and how data/requests flow through it.

## Key modules
- `{path}`: what it does

## Patterns & conventions
Short bullets. Focus on things that would not be obvious from reading the code — hidden constraints, important invariants, non-standard choices.

## Getting started
How to run dev, test, and build — pulled from the project docs or config.
```

Use the `write` tool to write the file.

## After writing

Report:
- The path of the written file
- A one-paragraph summary of the key facts for the current session
