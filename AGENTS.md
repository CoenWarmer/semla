<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# The goal of this app

Semla is an agent harness that focuses on reliability and traceability. The code it produces should always compile, validate. Code quality is paramount.

# Architecture

- large files are discouraged: break up large files into separate, dedicated files if possible

## Extension dependencies belong in this repository's package.json

**Decision.** A third-party pi extension package that Semla loads is declared in
the root `package.json`, pinned to an exact version, loaded by path out of the
root `node_modules`, and declared in `src/lib/pi/extension-manifest.ts`. It is
**not** declared in `.pi/npm/package.json`, and **not** listed in
`.pi/settings.json` for pi's own package resolution.

**Why.** `.pi/npm` is a separate dependency tree with its own lockfile, and
`npm audit` only ever sees the tree it is run in. When this was written the root
tree reported "found 0 vulnerabilities" while the two sibling trees held 25
between them, six of them high. Nothing in the repository said so.

What hid there is the argument. `@zosmaai/pi-llm-wiki` declares

```json
"peerDependencies": { "@mariozechner/pi-coding-agent": "*" }
```

— a wildcard range, against a scope pi has since been renamed away from, so it
can never be satisfied by the `@earendil-works/pi-coding-agent` this repository
pins. npm therefore installed a *second, older* agent runtime (0.73.1 alongside
our 0.84.2), carrying advisories that include a race in pi's `auth.json` writes
that can expose stored credentials — the very file `agent-dir.ts` is built
around.

There is a second reason, independent of security. A package loaded through
`.pi/settings.json` never appears in `extension-manifest.ts`, so it escapes the
load verification that exists precisely so that an extension which fails to load
cannot degrade into a session that quietly has no tools.

**How.** Four things, all of which have a home already:

1. exact version in the root `package.json` — a range would let a release move
   the entry file with no commit here;
2. a path constant in `runtime-config.ts` pointing into `node_modules`;
3. an entry in `EXTENSION_MANIFEST` declaring the tools it must register;
4. a contract test pinning the version and asserting the tool set against the
   installed package. `code-intelligence-contract.test.ts` is the worked
   example, and it also fails if the package reappears in `.pi/npm`.

Prefer a package's headless or non-interactive profile where it offers one.
Semla renders no TUI, so settings, footer and slash-command contributions are
dead weight, and tools that can apply edits should be an explicit choice rather
than something inherited from an interactive default.

**Known exception.** `@zosmaai/pi-llm-wiki` is still declared in `.pi/npm`. It is
deep-imported through computed path strings (see `wiki-ingest-bridge.ts` and
`wiki-package-contract.test.ts`) and it is the source of the wildcard peer
dependency above, so moving it is its own piece of work rather than a tidy-up.
`.pi/packages/semla-otel` also keeps its own lockfile.

# Validate your changes

Run tsc, lint and test to make sure your changes are valid.

`npm run audit:all` audits all three dependency trees, not just the root one.
It is expected to be red until the exception above is resolved; the point is
that the number is visible rather than hidden behind a clean root audit.

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
