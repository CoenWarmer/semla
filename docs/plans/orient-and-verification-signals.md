# Orient on this repo, and verification-signal discovery

Status: **implemented**, except §8 item 8 (UI), which §2 defers deliberately.

What landed, and where the implementation chose differently from the draft:

- Phase 3 (§8 items 1–2) in `src/lib/verification-signals/` and
  `src/lib/orient-status/`, with §7's tool in
  `src/lib/pi/extensions/orient-status.ts`.
- Phase 1 and phase 2 as further modes on the same tool (§8 item 4), the
  shared staleness comparison in `src/lib/orient-status/staleness.ts` (item 3),
  the skill step (item 5), and the prompt nudge (item 6).
- §10's first open question is **answered: report, do not poll.**
  `run: "code-index"` reports that a run started. `startIndexRun` never hands
  out the promise the work runs on, so polling would have meant re-deriving a
  fact the settings panel and the next `code_search` already report, at the
  cost of making orient's runtime the index's runtime.
- §5.3's `commitSha` and `dirty` are **nullable** in the implementation. A
  directory that is not a repository, and a repository with no commits, both
  genuinely have no sha; recording `""` there would be indistinguishable from a
  field nothing wrote. `isWikiStale` reports that as `no-commit-sha` rather
  than as "your wiki is out of date", because they call for different actions.
- **§5.1's path moved after shipping**, from `~/.semla/orient/` to
  `.semla-state/orient/`, keeping `SEMLA_ORIENT_HOME`. §5.2 has the reasoning:
  mirroring `indexHomeDir()` was the wrong precedent to follow for four
  scalars. `<project>/.semla-state/` was rejected because Semla should not
  write untracked files into repositories it does not own.
- §6's phase-1 row is honest about its cost rather than approximating it. The
  report says *indexed, freshness not recomputed* and never claims the index is
  current: confirming that needs the full tree hash `freshness()` already pays
  for per query. `describeStalePhases` therefore nudges only on
  *never-indexed*, so the section does not appear every turn on a fact that
  cannot be cheaply confirmed.

Revision note: this is a second draft. The first one was reviewed against the
code and three of its load-bearing assumptions did not hold — a markdown skill
cannot call a TypeScript module, a commit sha is the wrong freshness key for two
of the three phases, and a single status file written by three independently
triggered phases has no mutual exclusion. §4, §6, §7 and §8 are the parts that
changed; where the first draft's reasoning was wrong rather than merely
incomplete, the correction is stated rather than quietly applied, because the
wrong version is the intuitive one and will be proposed again otherwise.

## 1. Problem

Semla has three pieces of "know your repo" machinery that exist independently
and are never invoked together:

- the code-index (`src/lib/code-index/`) — semantic search over chunked source,
  kept current by a write-triggered reindex (`reindex-queue.ts`, driven by
  `code-search.ts`'s `tool_result` hook on `edit`/`write`) and reporting its own
  staleness at query time (`freshness()` in `search.ts`);
- the wiki `orient` skill
  (`src/lib/pi/extensions/dynamic-workflows/skills/orient/SKILL.md`) — captures
  README/history/deps/etc. into the LLM wiki as entity/concept/analysis pages;
- nothing at all for "what can verify a change here" — the agent currently has
  to rediscover, ad hoc and per-turn, whether there's a test runner, a linter,
  an e2e suite, a reachable dev server, or a connected MCP server worth
  calling.

The operator wants a single **"orient on this repo"** action that runs all
three, plus a way to occasionally re-run it so the picture doesn't go stale as
the repo changes under the agent.

**One correction carried forward from review.** The first draft described the
code-index as self-maintaining via "write-triggered reindex and a session-start
fingerprint check". There is no session-start fingerprint check. `session_start`
in `code-search.ts` sets cwd, resets nudges and creates the reindex queue;
nothing enumerates or hashes the tree. The tree hash comparison happens in
`freshness()`, at *query* time, and its result is reported to the model rather
than acted on. `docs/plans/code-index.md` §243 describes the session-start sweep
as intent. This matters because it is half the justification for keeping the
phases split (§3), and because the drift design (§6) now depends on knowing
exactly which freshness facts already exist and which do not.

## 2. Non-goals

- No UI/visualization work. This plan is the discovery mechanism and its
  output artifact only. A later plan can decide how (or whether) to surface it
  in a panel.
- No attempt to *run* tests/lint/e2e as part of discovery. Discovery answers
  "what exists and could be run", not "does it currently pass". Actually
  invoking a discovered signal remains an ordinary tool call the agent makes
  later, using the facts this produces.
- No new scheduler, cron, or turn counter. See §6 — the re-run decision is made
  where the prompt is already assembled, which needs neither.

## 3. Shape: three independent phases, one composite action

"Orient" is a **composite**, not a new subsystem. Each phase has its own entry
point; "orient" is the thing that invokes all three and reports one consolidated
result.

| Phase | Mechanism | New or existing |
|---|---|---|
| 1. Code-index refresh | `startIndexRun` in `src/lib/code-index/index-runs.ts`, which calls `indexProject` | Existing logic, **new agent-reachable entry point** (§7) |
| 2. Wiki orient | The `orient` skill's capture → ingest → analysis pipeline | Existing — reused as-is, already tool-driven |
| 3. Verification-signal discovery | New module, detailed below | **New** |

**Phase 1 is not reusable "as-is", which the first draft got wrong.** Phase 2 is
the only phase the skill can already reach, because the wiki ships tools
(`wiki_recall`, `wiki_capture_source`, `wiki_ingest`, `wiki_ensure_page`) and a
skill can instruct the agent to call a tool. Phase 1's only external surface is
`POST /api/code-index`, behind `requireUser()` and a workspace-whitelist check
on the path; `indexProject` itself is a TypeScript function with no tool in
front of it (`code-search.ts` registers `code_search`, which queries, not
reindexes). §7 is where that gap is closed.

The phases stay split because they have genuinely different costs and genuinely
different drift signals — see §6, which is now the real justification, since the
first draft's version of it ("phases 1–2 already self-maintain their own
freshness") was only half true.

## 4. Phase 3: verification-signal discovery

### 4.1 What it answers

For each of several signal categories, one of three states:

- **available** — statically confirmed present and usable (a `package.json`
  script exists, a config file for the tool exists).
- **configured-not-verified** — declared somewhere but not confirmed live
  (an MCP server is listed in `mcp.json` but connection wasn't probed; a dev
  server script exists but nothing checked whether it's currently reachable).
- **possible-not-configured** — a related dependency is present but nothing
  wires it up as a usable signal (e.g. `playwright` is a dependency but no
  `playwright.config.ts` and no script references it).

`possible-not-configured` is only ever emitted when a **dependency is actually
installed**, never from inferred intent. This is the one state whose volume
scales with the dependency count, and "you could add a linter" is not a finding
— the difference is whether something in the tree already paid for the tool.
This answers §10's open question from the first draft.

### 4.2 Categories to check, and how

| Category | Source of truth | Resulting state |
|---|---|---|
| Unit/integration tests | `package.json` `scripts.test` / `scripts["test:unit"]`; presence of `vitest.config.*`, `jest.config.*` | available when a script exists |
| E2e tests | `scripts["test:e2e"]`; `playwright.config.*`, `cypress.config.*` | available if a script exists; `possible-not-configured` if only the dependency is present; omitted entirely if neither |
| Lint | `scripts.lint`; `.oxlintrc.json`, `eslint.config.*` | available |
| Typecheck | `scripts.tsc` / `scripts.typecheck`; `tsconfig.json` | available |
| Dev server | `scripts.dev`; framework config implying a server (`next.config.*`) | always `configured-not-verified` in v1 — no probe, see §4.4 |
| MCP servers | `getMcpConfigSummary()` from `src/lib/pi/runtime/mcp-config.ts` | `configured-not-verified` per enabled server |

**Both script names are checked for typecheck, in that order.** This repo's
script is `tsc` (`"tsc": "npx tsc"`); there is no `typecheck`. The first draft
listed only the name this repo does not have, which would have reported
`typecheck` absent on the one repo the plan verifies against in §9.

**`browser-console` is dropped as its own category.** The first draft had a
"browser console / live page" row deriving from "whether a browser-capable MCP
server is configured *and connected*". Connection liveness is deferred (§4.4),
so in v1 that row could only ever restate one MCP entry as
`configured-not-verified` under a second name. It comes back when there is a
liveness probe to distinguish it.

**MCP connectivity is not available to this module, for a structural reason
worth recording.** The `mcp` tool's status mode does report per-server
`connected` / `needs-auth` / `failed` (`executeStatus` in
`pi-mcp-adapter/proxy-modes.ts`), but only inside a live Pi session — the
adapter publishes status as an event on its own `ExtensionAPI` instance.
`getMcpConfigSummary`'s docblock says exactly this, and `/api/mcp/status`
already accepts the narrower answer for the same reason. Phase 3 reads the
pinned config file and reports what it declares.

### 4.3 Output shape

```ts
type VerificationSignal = {
  category: "unit-test" | "integration-test" | "e2e-test" | "lint"
    | "typecheck" | "dev-server" | "mcp";
  state: "available" | "configured-not-verified" | "possible-not-configured";
  /** The fact that decided the state. e.g. 'package.json scripts.test = "vitest run"' */
  evidence: string;
  /** MCP server name, config file path, or dependency name. */
  detail?: string;
};
```

Where it lives is settled in §5: inline in phase 3's own status file. The first
draft left this as an open question in one section and answered it in the next,
arguing both sides; there is one answer now.

### 4.4 What's deliberately deferred

- **Live dev-server reachability probe** (actually hitting a port). Config
  presence is what v1 reports; an actual `fetch`/port-check is a reasonable
  follow-up once it's clear the static signal isn't enough on its own.
- **MCP connection liveness.** Confirming a configured server connects costs a
  real round trip, and per §4.2 is only answerable from inside a session that
  has the `mcp` tool bound. A follow-up can have the orient tool call it,
  since the tool *does* run inside such a session (§7) — which makes this a
  sequencing choice rather than an impossibility.

## 5. Persisted orient status, per project

Orient status is persisted so that drift detection (§6) and any future UI can
answer "when was this last done, and against what" without recomputing it. It is
not a wiki page and not a code-index row: it is a handful of scalars about a
job, which is the wrong shape for an embedded document store and the wrong shape
for a vector index.

### 5.1 One file per phase, not one file per project

```
<semla>/.semla-state/orient/<slug-hash>/wiki.json
<semla>/.semla-state/orient/<slug-hash>/verification.json

(root overridable via SEMLA_ORIENT_HOME; otherwise under SEMLA_STATE_DIR)
```

**Phase 1 is not persisted here at all.** Its status already exists and is
already durable: `head.json` carries `updated`, `chunks`, `model` and
`merkleRoot`, and `store.head(projectKey(root))` reads it — that is what
`getProjectIndexStatuses` already does for the settings panel. Writing a second
`capturedAt` for the code index would create two answers to "when was this last
indexed" that can disagree, and the derived one is the one that cannot lie.

**Two files rather than one, to remove the race instead of guarding it.** The
first draft had all three phases read-modify-writing one `status.json`, and
asserted that this meant "one phase's run never clobbers another's". Without
mutual exclusion it means precisely the opposite, and the draft's own §5.2
assumed the phases overlap. This repo has already paid for that lesson, in
`wiki-vault-lock.ts`:

> Source ids. `nextSequentialId` lists raw/sources, takes the highest and adds
> one. Two captures that both list before either writes get the *same* id, and
> the second packet overwrites the first. Nothing errors; a source just
> disappears.

`withVaultLock` is right there and would work. It is still the wrong answer
here: a lock is needed because two writers share one record, and these two
writers share nothing. One file each means no critical section, no stale-lock
timeout to tune, and no failure mode to test for. A single file would be worth
it only if a reader needed all phases to be consistent with each other at one
instant, and no reader does — §6 checks each phase independently.

### 5.2 Location keying

`projectKey(root)` from `src/lib/code-index/index-paths.ts` gives a stable
`slug-hash` derived from the absolute project path. Orient status is not
code-index state, so it does not live under `projectIndexDir(key)`; it gets its
own root.

**That root is `.semla-state/orient/`, not `~/.semla/orient/` — a correction
made after the first implementation shipped.** This section originally said the
root should mirror `indexHomeDir()`/`SEMLA_INDEX_HOME`, and mirroring it was
the mistake: the code index is genuinely large (~12 MB per project) and a cache
the user may want on another volume, which is what earns it a home-directory
root of its own. Orient status is four scalars and a signal list. It is Semla's
own state, in the same class as the review marks, run records, panel layout and
user settings that already live in `.semla-state/`, which is already gitignored
and already relocatable via `SEMLA_STATE_DIR`. Rooting it in the user's home
directory bought nothing and put per-project state somewhere no other part of
this application writes.

`<project>/.semla-state/orient/` was considered and rejected. It is
self-collecting — delete the repository and its status goes with it, which ends
the orphan problem below outright — but it writes an untracked directory into
repositories Semla does not own, where it surfaces in that repo's
`git status` and in the review panel as a change the agent did not make.
So the path stays keyed by project and rooted in Semla's own directory.

The overridable root is not a convenience. `index-paths.ts`'s docblock records
what happens without one: state keyed by a `mkdtemp` cwd but rooted at the real
home directory outlives the temp directory it describes, and nothing collects
it — 1,931 project directories and 127 MB in `~/.pi/workflows/projects`. These
files are tiny, so the exposure is directory count rather than bytes, but the
mechanism is identical and the fix costs one env var.

**On importing `projectKey` rather than copying it.** `index-paths.ts`
deliberately mirrors `workflowProjectKey()` instead of importing it, and the
first draft cited that docblock as precedent for reuse — which inverts it. The
docblock's argument is against the *import*: "a shared function would make
`src/lib/` depend on a vendored extension tree for nothing more than a naming
convention." That objection is about the vendored tree and does not apply to one
`src/lib/` module importing another, so importing is fine here. But the
coupling it creates is real and its failure is silent: change the derivation in
`code-index` and every existing status directory orphans, so orient reports
never-run for a repo it oriented yesterday. Two cheap things make that loud
instead — the derivation is pinned by a test, and each file carries the absolute
`root` it describes, so an orphan is identifiable rather than merely absent.

### 5.3 Schema

```ts
type WikiStatus = {
  /** Absolute project root this describes; also detects an orphaned directory. */
  root: string;
  capturedAt: string;  // ISO
  commitSha: string;
  /** Whether the working tree had uncommitted changes at capture time. */
  dirty: boolean;
};

type VerificationStatus = {
  root: string;
  capturedAt: string;
  /** sha256 over the exact input files read, in a fixed order. See §6. */
  inputsDigest: string;
  signals: VerificationSignal[];
};
```

A missing file means that phase has never run — which is a first-class state,
not an error, exactly as "not indexed" is for the code index. A corrupt file is
reported to the caller rather than thrown, for the same reason: orient's job is
to tell you what it knows.

## 6. Drift: what makes each phase stale

This section is the one the first draft got most wrong, so the reasoning is
spelled out. It used a single key — `git rev-parse HEAD` — for all three phases,
compared per turn, and claimed a check costs "one `git rev-parse` and three
file-existence-shaped reads".

**A commit sha is the wrong key for a harness whose whole job is editing files.**
The dominant state here is *uncommitted* work: the agent edits all turn and
commits at checkpoints (per AGENTS.md, after a working checkpoint). The sha is
constant across exactly the window in which the index goes stale, so the first
draft's design would have skipped the re-run during precisely the period it
exists to catch. The code-index already solved this with a content hash, and the
plan was proposing a weaker signal than the one sitting next to it.

But the fix is not "use the tree hash everywhere" either — the three phases
consume different inputs, so they need different keys:

| Phase | Stale when | Cost to check |
|---|---|---|
| 1. Code-index | `treeRoot(fingerprints) !== head.merkleRoot` — the existing comparison in `freshness()` | Full enumerate + hash of the tree. Not cheap. |
| 2. Wiki | `commitSha` moved, or `dirty` was true at capture | One `git rev-parse HEAD` + one `git status --porcelain` |
| 3. Verification signals | `inputsDigest` moved | Hash of ~6 named files |

**Phase 2 is the one phase for which a commit sha is genuinely right.** Its
inputs are README, AGENTS.md, dependency manifests, design docs under `docs/`,
and git history — things that move on commit boundaries and are described by the
commit graph. A wiki page about a load-bearing decision does not go stale
because a function body changed. So the sha is not a weaker proxy here; it is
the matching granularity. `dirty` is recorded because a capture taken against a
dirty tree describes something no sha identifies, which is the only honest way
to represent it. This answers §10's third open question from the first draft:
`dirty` goes in, and not as a nicety.

**Phase 3 gets an inputs digest, not a tree hash or a sha, because one of its
inputs is not in the repo.** `MCP_CONFIG_PATH` is `join(PI_AGENT_DIR, "mcp.json")`
— `~/.semla/agent/mcp.json`, per-machine, outside every project. A per-project
commit sha cannot detect MCP config drift at all, which was awkward in the first
draft because §3 justified phase 3's separate timescale on exactly that drift
("a dependency or MCP config changes"). Hashing the concatenation of the files
actually read — `package.json`, the tool configs found, and the global
`mcp.json` — covers both the in-repo and out-of-repo inputs, is exact rather
than a proxy, and costs about six reads. It also correctly ignores source edits,
which are not phase 3's business.

**Phase 1's check is the expensive one, and is not run on a turn boundary.**
`freshness()` enumerates the project and hashes every file. That is affordable
per `code_search` call, where it already happens; it is not affordable per turn
on a large tree. So phase 1's staleness is only computed when orient is
explicitly invoked, or read cheaply-and-approximately from `head.json`'s
`updated`/`merkleRoot` without recomputing the actual root.

### 6.1 Where the check runs: the system prompt, not a turn counter

The first draft proposed mirroring "`InspectorPanel`'s existing runs
automatically every 10 turns pattern
(`src/components/session-panels/inspector-panel.tsx`)". That file contains the
sentence as UI copy and nothing else. The mechanism is in
`client-session-component.tsx`:

```330:340:/Users/coen/Dev/semla/src/components/client-session-component.tsx
  // After every 10th user prompt, trigger a background context-quality check.
  const prevPendingRef = useRef(false);
  useEffect(() => {
    const wasJustPending = prevPendingRef.current && !isActive;
    prevPendingRef.current = isActive;
    if (!wasJustPending) return;
    const userMsgCount = messages.filter((m) => m.role === "user").length;
    if (userMsgCount > 0 && userMsgCount % 10 === 0) {
      contextCheckTrigger.mutate();
    }
  }, [isActive, messages, contextCheckTrigger]);
```

That is client React state with no store and no server counter, so building on
it would put orient's drift check in a browser component that only fires while
someone has the session open — for a harness that runs turns headlessly, a
staleness check that depends on a mounted panel is not a staleness check.

There is already a server-side mechanism doing this exact job, one turn at a
time, and it is the one that steers orient today. `buildMemoryContextBlock` in
`src/lib/pi/prompt/prompts.ts` assembles a per-turn block for the anchored
project and already ends with:

```124:127:/Users/coen/Dev/semla/src/lib/pi/prompt/prompts.ts
    lines.push(
      "",
      "Before starting work: call `wiki_recall` with the project name to check for existing codebase knowledge. If no pages are returned, invoke the `orient` skill to initialise the wiki for this repo.",
    );
```

The drift nudge belongs beside that line: read the two status files, compare
per §6, and append a sentence naming the stale phases. This needs no counter
(every turn already rebuilds the block), runs server-side regardless of any open
panel, and reuses the mechanism that already turns a repo fact into an agent
action. The cost per turn is two small file reads, one `git rev-parse`, one
`git status --porcelain`, and six config hashes — phase 1's expensive
enumeration deliberately excluded.

Nudging rather than auto-invoking is the right default for the same reason
`code_search` is registered unconditionally: a capability the model is told
about is one it can act on or explain declining, whereas work that happens to it
mid-task is neither.

## 7. Invocation: a tool the skill calls

**The first draft's plan here could not be built.** It said to extend the
`orient` skill to "run phase 3 and write all three phases' status via the
persistence module". Skills in `dynamic-workflows/skills/` are plain markdown,
discovered by Pi's `DefaultResourceLoader` via `additionalSkillPaths` and
injected into the system prompt. The agent following that markdown can call
**tools** or **bash** — which is what every existing orient step does. It cannot
import a TypeScript module, so "run the discovery module and write the status
file" had no mechanism behind it.

**Resolution: one new factory extension registering an `orient_status` tool.**
Semla's own extensions are imported factories declared in
`extension-manifest.ts`, and a factory runs inside the Next server process with
the `@/` alias working — `code-search.ts` is the worked example, importing
`@/lib/code-index/indexer` and friends directly. So a factory can call
`startIndexRun`, the phase-3 discovery module and the persistence module with no
HTTP hop and no auth dance.

The manifest entry:

```ts
{
  id: "orient-status",
  source: { factory: orientStatusExtension, kind: "factory" },
  requires: [],
  // Every answer is about one project: which index, which status file, which
  // package.json. Without an anchor there is nothing to report on.
  requiresProjectAnchor: true,
  providesTools: ["orient_status"],
  optionalTools: [],
  providesSlots: [],
  remedy: "This extension is imported directly; a failure here is a code problem in src/lib/pi/extensions/orient-status.ts.",
}
```

`requiresProjectAnchor` puts it in the same class as `code-search` and
`code-intelligence`, and `assertManifestIsCoherent` will enforce that nothing
unanchored requires it.

**This does not make orient autonomous, which is what §7 of the first draft
actually wanted to avoid.** That draft framed the choice as "skill-level for
now, not an autonomous tool", but those are answers to different questions: one
is *who decides to invoke*, the other is *whether a callable entry point
exists*. A tool the skill instructs the agent to call at a numbered step is
skill-invoked. Keeping the tool out of the picture does not delay the decision;
it just leaves the step unimplementable.

Tool modes, so one tool covers reporting and doing:

- `orient_status({})` — read both status files, compare per §6, report each
  phase's state. No writes. This is also what the prompt nudge (§6.1) renders
  from, sharing one comparison rather than two.
- `orient_status({ run: "verification-signals" })` — run phase 3, write
  `verification.json`, return the signals.
- `orient_status({ run: "code-index" })` — `startIndexRun(root)`, which returns
  immediately by design (see `index-runs.ts` on why it cannot await), so the
  tool reports that a run started rather than its result.
- `record: "wiki"` — write `wiki.json` after the skill's ingest step completes.
  Phase 2 is driven by the wiki's own tools across many steps, so the skill
  tells the tool when it finished; the tool does not run the wiki pipeline.

**The `scripts/*.mjs` alternative, and why not.** A CLI the skill invokes via
bash would also work and matches an existing precedent. It loses the type graph:
`tsconfig.json` covers `src/**` only, and `.oxlintrc.json` turns the type-aware
rules off for `**/*.mjs` — so `no-floating-promises` and `no-base-to-string`,
which AGENTS.md calls out as the interesting ones for a traceability harness,
would not run on it. A factory extension is checked like the rest of the app.

## 8. Work breakdown

1. **Phase-3 discovery module**, `src/lib/verification-signals/`, sibling to
   `code-index/` and `context-check/`: the per-category file and script checks
   from §4.2, MCP enumeration via `getMcpConfigSummary()`, and the
   `inputsDigest` over exactly the files it read. Returns
   `VerificationSignal[]` plus the digest.
2. **Persistence module**, `src/lib/orient-status/`: `orientStatusDir(root)`
   mirroring `projectIndexPaths`, plain read/write per phase file (no
   read-modify-write, no lock — §5.1), and the git helpers for `commitSha` and
   `dirty`.
3. **Staleness comparison**, in the persistence module so the tool and the
   prompt block share one implementation: given the two files plus the cheap
   git/digest facts, return which phases are stale and why. Phase 1 compares
   against `head.json` via `store.head()` without recomputing the tree root.
4. **The `orient_status` extension**, `src/lib/pi/extensions/orient-status.ts`,
   with the manifest entry and modes from §7.
5. **Extend the `orient` skill.** Insert a new **step 7** ("Verification
   signals and status") between the existing step 6 ("Record the decisions")
   and step 7 ("Report"), which becomes step 8; the new step calls
   `orient_status` with `run: "verification-signals"` and `record: "wiki"`, and
   step 8 folds the result into the report. The first draft called this
   "Step 3.5, between wiki ingest and the final report" — ingest is step 5,
   report is step 7, and step 6 already sits between them, so 3.5 would have
   landed between "Initialise the wiki" and "Capture sources".
6. **The prompt nudge**, in `buildMemoryContextBlock` (§6.1), appending a
   stale-phase sentence beside the existing `wiki_recall` line.
7. **Tests** (see §9).
8. No UI work in this pass — explicitly deferred per §2.

## 9. Verification of this work itself

Unit tests are the primary check, and none of them need a dev server or a live
MCP connection, since phase 3 only reads static config:

- **Discovery, per category**: given a fixture `package.json` and config set,
  assert the `state` and the `evidence` string. Including the two cases the
  categories table turns on: `scripts.tsc` *or* `scripts.typecheck` both yield
  `typecheck: available`; and `playwright` as a dependency with no config and no
  script yields `possible-not-configured`, while neither dependency nor config
  yields no `e2e-test` signal at all.
- **Inputs digest**: moving any one input file moves the digest; reordering the
  files does not. The out-of-repo case specifically — editing `mcp.json` under a
  redirected `PI_AGENT_DIR` must move the digest, since that is the drift a
  commit sha provably cannot see.
- **Persistence**: a missing file reads as never-run; a corrupt file is reported
  rather than thrown; a status file whose `root` does not match the project is
  identified as orphaned. Writing one phase cannot affect the other's file —
  which with §5.1's split is a structural property rather than a race to test,
  and is asserted as such.
- **Key derivation**: `orientStatusDir` is pinned against `projectKey`, so a
  change to the code-index derivation fails a test instead of silently orphaning
  every status directory (§5.2).
- **Manifest**: `orient_status` appears in `providesTools` and the extension
  loads — `extension-manifest-load.test.ts` already covers this shape.

Then manually, against this repo:

- `npm test` → vitest present, so `unit-test: available` with evidence
  `scripts.test = "vitest run"`; `npm run lint` → `lint: available`;
  `scripts.tsc` → `typecheck: available`. No `test:e2e` script and neither
  playwright nor cypress in `package.json`, so no `e2e-test` signal at all —
  not `possible-not-configured`, per §4.1.
- MCP: **read whatever `~/.semla/agent/mcp.json` actually declares** and check
  the signals against that. The first draft asserted `brave-devtools` would be
  listed; it is in the operator's agent dir, but in-repo it appears only in
  `mcp-config.test.ts` fixtures, so it is an environment fact and this step must
  not be written as though the repo guarantees it. A machine with no `mcp.json`
  should produce no `mcp` signals and no error.
- Read `.semla-state/orient/<slug-hash>/` directly and confirm `wiki.json` records
  a `commitSha` matching `git rev-parse HEAD` with the right `dirty`, and that
  `verification.json` records a digest that changes after touching
  `package.json`.
- `npm run tsc` and `npm run lint`, same as any other change.

## 10. Open questions for review

- ~~Phase 1's mode starts a background run and returns immediately. Poll or
  report?~~ **Answered: report.** See the status note at the top.
- The prompt nudge (§6.1) adds a `git rev-parse` plus a `git status --porcelain`
  to every turn's prompt assembly for an anchored project. That is small, but it
  is on the hot path before the model sees anything — worth confirming it is
  acceptable there rather than behind a cheaper gate, such as only re-checking
  when the status file's `capturedAt` is older than the newest mtime in the
  project.
- Whether `integration-test` is worth keeping as a distinct category from
  `unit-test`. Nothing statically distinguishes them in a `package.json` that
  has only `test`, and this repo is that case — so it may always collapse into
  `unit-test` in practice and exist only to be empty.
