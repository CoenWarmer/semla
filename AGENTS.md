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
root `node_modules`, and declared in `src/lib/pi/extension-loading/extension-manifest.ts`. It is
**not** declared in `.pi/npm/package.json`, and **not** listed in
`.pi/settings.json` for pi's own package resolution.

**Why.** `.pi/npm` was a separate dependency tree with its own lockfile, and
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
   example. `.pi/` is gone entirely, and `pi-dir-removed.test.ts` keeps it
   gone; the reasons are in that file's docblock and both are sharp.

Prefer a package's headless or non-interactive profile where it offers one.
Semla renders no TUI, so settings, footer and slash-command contributions are
dead weight, and tools that can apply edits should be an explicit choice rather
than something inherited from an interactive default.

**No exceptions left, and `.pi/` is gone.** `@zosmaai/pi-llm-wiki` was the last
package in `.pi/npm`; `semla-otel` was the last thing in `.pi/packages`, loaded
by nothing and reachable only through `.pi/settings.json`. There is one
dependency tree now.

Deleting `.pi/settings.json` was not housekeeping. pi reads a project-scope
`settings.json` **from its cwd**, and Semla's sessions used to run at the
workspace root, where there was no such file. Anchoring a session to its own
project made this repository's own one live, and its `packages` list told pi to
install and load the wiki a *second* time: nine extensions instead of seven,
`.pi/npm` recreated from the registry — unpatched, so no ingest dispatcher hook
— and fourteen tool-name conflicts, with the registration race deciding whether
`wiki_ingest` worked. Which is the failure `PI_AGENT_DIR` exists to prevent,
arriving by a path nobody had looked at.

Moving it needed three things that are worth knowing before touching any of it.

**It is patched.** The published tarball has no
`Symbol.for("semla.wiki-ingest-dispatcher")` hook, so without the patch
`wiki-ingest-bridge.ts` installs a dispatcher that nothing ever calls and
`wiki_ingest` falls back to inline synthesis — with no error, because the line
that would have called it is simply absent. The patch also switches `wiki_lint`
and `wiki_rebuild_meta` from background to synchronous, and adds a repo
derivation to the ingest worker.

Those edits used to exist only in `node_modules`, untracked and reproducible by
nothing. They survived only because npm does not re-extract a package that
already matches the lockfile, so `npm ci`, a fresh clone, or one cache miss
would have removed them silently. They are committed under `patches/` now and
re-applied by `scripts/apply-package-patches.mjs`, which `postinstall` runs
after the trees are installed. It is strict on purpose: a patch that no longer
applies, or a version that has moved away from the one it was cut against,
fails the install rather than leaving the tree half-patched.

The patch touches the package's `.ts` sources, not its `dist/`. That is what
runs: `WIKI_EXTENSION_PATH` points jiti at `extensions/llm-wiki/index.ts`. The
`dist/*.js` files the bridge deep-imports are pristine, and the hook is not in
them at all.

**Its old-scope imports need two different mechanisms, for two different
reasons.** The package imports `@mariozechner/pi-coding-agent`,
`@mariozechner/pi-tui` and `@mariozechner/pi-agent-core` — a scope pi has since
been renamed away from. Of eighteen imports of the first, only two are values
(`getAgentDir`, `isToolCallEventType`), and both exist on the renamed package;
`@mariozechner/pi-ai` appears only in type positions, which jiti erases.

- `pi-coding-agent` and `pi-tui` are **declared** by the package, the first as
  `peerDependencies: { "@mariozechner/pi-coding-agent": "*" }`. A wildcard
  against an abandoned scope is what npm answered by installing a *second*
  agent runtime, 0.73.1, with two high-severity advisories including a race in
  `auth.json` writes that can expose stored credentials. Two `overrides` alias
  those edges onto the packages this repository already pins.
- `pi-agent-core` is **not declared at all** — an undeclared import that used
  to resolve by accident against a transitive of that vulnerable runtime.
  `overrides` cannot help, because there is no dependency edge to rewrite. It is
  an aliased entry in `dependencies` instead:
  `"@mariozechner/pi-agent-core": "npm:@earendil-works/pi-agent-core@0.84.2"`.

Both are asserted in `wiki-package-contract.test.ts`, against `package.json`
*and* against what npm actually put on disk, because removing either brings the
vulnerable copy back silently.

**Every path into the package derives from `WIKI_PACKAGE_DIR`** in
`runtime-config.ts`. There were six spelled out across three files when this
moved, which is why there is now one.

## All Semla settings and debug artifacts live in the Semla directory, never a host's `~/.pi` directory

**The rule.** All settings and debug artifacts concerning Semla's own operation
— including those written by or for a Semla-loaded extension — must live in a
Semla-owned location. None of this state may be stored in a host's `~/.pi`
directory. `~/.pi` is the `pi` CLI's own configuration home, shared with any
other tool on the machine that happens to invoke `pi`; Semla does not own it
and must not write to it as though it does.

**Which Semla-owned location, and this is the part that is easy to get wrong.**
The default is **in-repo**, in the gitignored `.semla-*` directories beside the
artifacts an operator already looks in: `.semla-state/` for state
(`SEMLA_STATE_DIR`), `.semla-debug/` for conversation artifacts,
`.semla-sessions/`, `.semla-artifacts/`, `.semla-wiki/`. A home directory is the
exception, not the default, and it earns itself for exactly one reason:
`~/.semla/agent` holds `auth.json`, and real credentials in a gitignored in-repo
directory are still one `git add -f` from a commit. If what you are storing is
not a credential, it goes in the tree.

This was learned twice. `orient-status/paths.ts` records the first time — it
followed `indexHomeDir()` to `~/.semla/orient` and put per-project state in a
home directory "for no reason this module needs", then moved to
`.semla-state/`. The workflow home below is the second: the rule above used to
read as flatly `~/.semla/...`, and a fix that took it literally moved 66 MB of
run journals from `~/.pi/workflows` to `~/.semla/workflows` — out of the `pi`
CLI's directory, which was the point, but into a home directory the precedent
had already rejected. The wording is the cause, so the wording changed.

**Why this rule exists.** `src/lib/pi/runtime/agent-dir.ts` isolates the agent
runtime's credentials and model catalog to `~/.semla/agent` for exactly this
reason: `getAgentDir()` in pi-coding-agent resolves to `~/.pi/agent` by
default, and every `ModelRuntime` resolves it independently, so without
isolation a change to the host's `auth.json` silently changes Semla's
behaviour with no change to Semla itself. Storing the directory *inside* the
repo was also rejected: `auth.json` holds real credentials, and an in-repo
directory would put them one `git add -A` away from being committed. The same
reasoning holds for every other kind of settings or debug output, not only
credentials — any of it left in a shared, host-owned directory is state Semla
does not control and cannot distinguish from state left by an unrelated `pi`
session on the same machine.

**The one exception is closed.** `dynamic-workflows` kept all of its state —
settings, saved workflows, run journals, locks, and the tier config — under
`~/.pi/workflows`, including the Jev-gate toggle exposed in the PromptEditor.
It was never migrated when `agent-dir.ts` was written and nothing documented it
as deliberate. It is now `<semla>/.semla-state/workflows`:
`WORKFLOW_STATE_SUBDIR` joined onto `semlaStateDir()` in
`dynamic-workflows/src/workflow-paths.ts`, still reached only through
`workflowHomeDir()` so `PI_WORKFLOW_HOME` keeps overriding it. The committed
per-repo tier file did **not** go with it — it is
`.semla/workflows/model-tiers.json`, under `WORKFLOW_PROJECT_RELATIVE_DIR`,
because `.semla-state/` is gitignored and that file is meant to be committed
and reviewed. It did have to leave `.pi/`, which claims a name Semla does not
own in every checkout it runs against.

Four things about that move are load-bearing.

`semlaStateDir()` **duplicates** `SEMLA_STATE_DIR` from
`stores/user-settings-store.ts` rather than importing it. Nothing in the
dynamic-workflows tree uses the `"@/"` alias, because the tree is also loaded
outside Next — `scripts/backfill-stuck-workflow-agents.mjs` imports
`workflow-paths.ts` under plain node, where the alias does not resolve. Reading
the same env var with the same fallback is what keeps the two agreeing, and a
test pins it.

Its `process.cwd()` is the **server's** root, never a session's. Nothing in the
app calls `process.chdir` and sessions are handed a cwd instead (see
`session-cwd.ts`). This matters because the project key *is* derived from a
session cwd: if the root were too, every repository Semla touched would grow its
own workflow state directory, which is the scattering the shared home was
introduced to end.

An operator's existing home is **relocated once**, by
`migrateLegacyWorkflowHome()` in `workflow-paths.ts`, not read as a fallback. A
fallback would keep a home-directory copy live forever, which is the state the
move exists to end. There are two legacy locations, since this moved twice —
`~/.semla/workflows` then `~/.pi/workflows`, newest first, first one that exists
wins — so an operator who ran the intermediate build carries forward the copy
they were actually using. It **never merges**: if the target already exists it
wins and the legacy directory is left alone, because two `projects/` trees keyed
the same way would resurrect runs the retention cap in `run-persistence.ts` had
already collected, with no ordering to resolve a clash. And it is not attempted
when `PI_WORKFLOW_HOME` is set — an override is a deliberate destination (a temp
dir, in the test suite), not somewhere real history should be moved into.

The project tier path does have a read fallback, in
`getProjectModelTierConfigPath()`, because that file is committed and a
checkout can be older than this change. It reads and never writes, so a save
against an old checkout rewrites in place rather than creating a second file the
loader would have to rank.

`pi-dir-removed.test.ts` now forbids `.pi/workflows` alongside `.pi/npm`,
`.pi/packages` and `.pi/settings.json`. `.pi/worktrees/` and `.pi/agents/`
remain fine: the first is a worktree location, the second a cwd-relative
convention the extension only *reads*.

**Going forward.** Do not add any new file under a host's `~/.pi/` to hold
Semla-specific state, and do not treat an existing `~/.pi/...` path as safe to
keep writing to just because it already works. New settings, caches, or debug
output default to the gitignored in-repo `.semla-*` directories — usually a
subdirectory of `.semla-state/` via `SEMLA_STATE_DIR` — or to an override that
points at one. Reach for `~/.semla` only for credentials, and say in the code
why the tree was not good enough.

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

## TypeScript 7, and what it costs

**Decision.** This repository is on TypeScript 7 — the native compiler — as its
only TypeScript. `tsc` type-checks the project in about a second where TS 5 took
five. Nothing is pinned to 5.x alongside it.

**Why it is not just a version bump.** TS 7 removed the JS compiler API. The
`typescript` package exports `tsc` and a version string; `ts.createProgram`,
`ts.forEachChild`, `ts.SymbolFlags` and the rest are gone. In their place is a
new API under `typescript/unstable/*`, and it is a different thing rather than a
rename:

- `typescript/unstable/sync` gives `API`, `Project`, `Program`, `Checker`,
  `Symbol`. A program is a **subprocess**, not an object — `new API()` spawns the
  native compiler and every node, symbol and type is a handle into it.
- `typescript/unstable/ast` has the node types; `typescript/unstable/ast/is` has
  the predicates. `forEachChild` is a method on a node, not a free function.
- A symbol's `declarations` are `NodeHandle`s. Each has to be `resolve(project)`d
  before it can be read, and that is a round-trip.
- There is no `getNameOfDeclaration`. `declarations.ts` has a local replacement.

`src/lib/code-map/` is the only consumer and is written against that API. Two
things there are load-bearing. Disposal is one: an entry dropped from the program
cache without `release()` leaks a running compiler, and the panel rebuilds every
time a node is expanded. The other is that `unwrapDeclaration` takes a `Node`
rather than a branded `Declaration` — deliberately, so callers resolving a handle
do not have to assert a brand to satisfy a function that only ever used
predicates.

**The language server.** TS 7 ships no tsserver, so `typescript-language-server`
is uninstalled and cannot be reinstated — it has nothing to drive. TS 7 serves
LSP from the compiler binary as `tsc --lsp -stdio`, and supi spawns
`typescript-language-server --stdio` by name on PATH. The translation is
`scripts/language-servers/typescript-language-server`, a shim on a PATH entry
this repository controls; see the docblock in `src/lib/pi/runtime/language-servers.ts`
for why a shim rather than supi's own config. Note the single dash in `-stdio`:
`--stdio` is accepted and then exits without answering `initialize`.

**What still works.** `next build` builds, and the LSP advertises
`diagnosticProvider`, which typescript-language-server 5.3.0 did not — supi's own
capability notes list it as missing there.

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

`npm run audit:all` audits every dependency tree this repository installs.
There is one now, so it is close to plain `npm audit` — it survives as the
single place a second tree would have to be declared, because a tree that is
not declared there is a tree `npm audit` silently does not see. That is not
hypothetical: it is how two high-severity advisories sat in `.pi/npm` while the
root reported none. `pi-dir-removed.test.ts` is the other half.

## Do not reach for `git stash` to get a clean tree

**Decision.** Run `npm run tsc`, `npm run lint` and `npm test` against the tree
as it is. Do not `git stash` to isolate your own changes, and do not
`git checkout -- <file>` to start a file again.

**Why.** Both were tried in one session on 2026-09-04, to get a clean baseline
for lint and a build. They cost thirteen minutes and a slice of a
thirteen-dollar run, and produced nothing that was not already there.

`git stash` looks local and reversible and is neither.

- It rewrites the entire working tree. Every file you have edited disappears
  and comes back, and in this repository those files are live modules in the
  graph of the `next dev` the operator is watching — so Turbopack rebuilds the
  application underneath the session you are running inside. `git stash;
  npm run build; git stash pop` at 13:50 is why the operator asked "are you
  still running?" thirteen seconds later.
- Subagents share this working tree. A stash takes their in-flight edits with
  it, and they have no way to find out why.
- The stash stack is shared and long-lived, and an entry on it carries no sign
  of whose it is. `stash@{0}` here is `WIP on main: 5074e4a Tweaks`, from a
  fortnight before that session. The agent found it, took it for its own, and
  spent nine minutes reconciling a stranger's changes against its own — running
  `git checkout --` on two files repeatedly and re-deriving work it had already
  written correctly.

`git checkout -- <file>` discards work with no undo and no record. There is no
reflog for the working tree.

**What to do instead.** Nothing. tsc, lint and test do not care that the tree is
dirty. If lint output is noisy, filter it — `npm run lint 2>&1 | grep <path>` —
rather than removing the changes you are not interested in. A worktree is not
the alternative either: a fresh one has no `node_modules`, so tsc and lint pass
there without having checked anything.

**`npm run build` is a caution, not a prohibition.** It shares `.next/` with a
running `next dev`, so the two can disturb each other. In practice it is
survivable and worth doing — a build is what catches the errors `tsc` cannot,
such as a bundler emitting a worker entry as a static asset. Just do not
combine it with a stash.

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
