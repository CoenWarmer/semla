<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# The goal of this app

Semla is an agent harness that focuses on reliability and traceability. The code it produces should always compile, validate. Code quality is paramount.

# Architecture

- large files are discouraged: break up large files into separate, dedicated files if possible

# Validate your changes

Run tsc, lint and test to make sure your changes are valid.

# Debugging

There are conversation artifacts stored in .semla-debug. You can use those to investigate issues.

### Split unrelated changes into separate commits

- If one file contains unrelated changes, split them by hunk instead of committing the whole file.
- Keep tests with the behavior they verify.
- Split generated output, docs-only edits, or mechanical cleanup into separate commits when each commit remains coherent on its own.
- If the split is ambiguous, summarize the options before committing.

### Commit message convention

- Follow the `[Component]: summary` commit-message convention when writing commit messages.

### Commit checkpoints after each turn

- Commit after a working checkpoint, when the requested change is complete and relevant checks have passed or been reported.
