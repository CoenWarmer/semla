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

## Extensions are imported, not pointed at

**Decision.** An extension this repository writes is handed to Pi as an imported
factory — `source: { kind: "factory", factory }` in `extension-manifest.ts`,
passed through `extensionFactories`. A file path for Pi's own loader is reserved
for third-party packages that publish TypeScript source.

**Why.** Pi compiles path-loaded extensions with jiti, which resolves module
specifiers differently from both tsc and Next: no `"@/"` alias, and an import
that type-checks can still fail to load. Importing them instead puts them
through the same toolchain as the rest of the app, so the two agree.

**Why the exception is not laziness.** Neither third-party package ships a
compiled extension entry, in any version, and both are published expecting a
transpiling loader. Node refuses to strip types under `node_modules`; a static
import drags tsc into source that does not type-check here; and bundling breaks
`import.meta.url`, which `@mrclrchtr/supi-tree-sitter` uses to spawn a worker and
locate 31 grammar files. jiti transpiles *in place*, which is precisely why those
packages expect it.

**The constraint to remember.** Pi loads every path extension before any
factory. So a path extension may not `require` a factory — `wiki-ingest-bridge`
is a factory that depends on the path-loaded wiki extension, and the reverse
would fail as an undefined contract slot rather than an error.
`assertManifestIsCoherent` rejects it, and `extension-manifest-load.test.ts`
proves Pi still orders them that way.

**Two consequences worth knowing before you add one.** A bundled extension's
`await import(computedPath)` will be statically analysed by Turbopack and fail —
mark those `turbopackIgnore`. And a dynamic import of a `.ts` file only resolves
when the importing module was itself loaded by jiti, so reach for a package's
`dist` build, not its source.

# Validate your changes

Run tsc, lint and test to make sure your changes are valid.

`npm run lint` is oxlint, configured in `.oxlintrc.json`. It replaced ESLint and
`eslint-config-next`, which are no longer installed — `next build` does not run a
linter in Next 16, so nothing else depends on them.

The reason the swap was safe is that oxlint implements the React Compiler rules
this repository actually relies on. `reactCompiler` is on in `next.config.ts`, so
`react/set-state-in-effect`, `react/refs`, `react/immutability`,
`react/static-components` and `react-hooks/exhaustive-deps` are the rules that
tell you a component has fallen out of the compiler's reach. oxlint reports the
same violations at the same sites eslint-config-next did.

Severities are pinned by name for the `jsx-a11y` and `nextjs` rules, because
oxlint files those under `correctness` (error) while eslint-config-next raised
them as warnings; the explicit `"warn"` entries keep the compiler rules the only
errors, so a real one is not buried.

**The lint is type-aware.** `--type-aware` is on in the `lint` script, which is
why `oxlint-tsgolint` is a devDependency — without it oxlint exits with "Failed
to find tsgolint executable". It costs about a second (~0.9s to ~1.9s for the
whole repository) and buys the rules that need a checker: `no-floating-promises`,
`await-thenable`, `no-base-to-string`, `unbound-method`,
`require-array-sort-compare`. For a harness whose product is traceability, those
are the interesting ones — a floating promise is work that silently did not
happen, and `no-base-to-string` caught an `[object Object]` on its way into a
model prompt as a source title.

Two limits are encoded in the config. `**/*.mjs` has the type-aware rules turned
off, because `tsconfig.json` includes only `src/**`: those scripts are outside
the type graph, every value in them is `any`, and the findings describe that
rather than the code. And `src/types/database.types.ts` is ignored outright
because `npm run generate:db-types` rewrites it, so a fix there does not survive.

Suppressions are `// oxlint-disable-next-line <rule>`. oxlint still honours
`eslint-disable` comments, but nothing in this repository should add one.

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
