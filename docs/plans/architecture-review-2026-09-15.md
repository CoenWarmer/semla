# Architecture review — 2026-09-15

A full-codebase review of organisation, dead code, and comment accuracy. Run
independently of `docs/plans/architecture-review.md`, which was deliberately not
read, so the two can be compared.

Method: a repo-wide static pass (module graph with `@/`, relative, dynamic and
re-export edges resolved; export-level reachability; function-length
measurement) plus four parallel deep reads of `src/lib/pi` core,
`src/lib/pi/extensions`, `src/app` + `src/components`, and
`src/hooks` + `src/lib`. Every finding below was verified against the file
before being written down. Line numbers are against the working tree as
reviewed, which was dirty.

## Baseline

The tree is green and the discipline is real.

| Check | Result |
|---|---|
| `npx tsc` | clean |
| `npm test` | 226 files, 2524 tests, all passing |
| `npm run lint` | 33 warnings, 0 errors |
| `TODO`/`FIXME`/`XXX`/`HACK` markers in `src/` and `scripts/` | 0 |
| Files nothing imports | 0 (once dynamic `import()` is accounted for) |

Every file, test and script that `AGENTS.md` names by path exists. The
`typescript-language-server` shim matches its documentation exactly, including
the single-dash `-stdio` detail. 12 of 17 plan documents under `docs/plans/` are
cited from code. This is a codebase whose documentation is load-bearing rather
than decorative, which is what makes the drift catalogued in section 4 worth
fixing: here, a stale comment actually misleads someone.

---

## 1. Correctness defects

### 1.1 `semla.session.prompts` is always 0 — HIGH

`src/lib/trace/recorded-spans.ts:199-201` counts prompts with
`children.filter((span) => span.name === "Prompt")`. But `children` is `roots`,
derived at line 369 from `mapped`, and `mapped` sets `name: labelOf(span)`
(line 340). For a prompt span `labelOf` returns `promptLabel(excerpt)`, which is
the prompt's own text and is only the literal string `"Prompt"` when there is no
excerpt at all — a case the comment at line 101 describes as "a prompt recorded
before this existed".

So the attribute counts legacy excerpt-less prompts only, and reads 0 for every
session recorded since excerpts landed. The session row that exists to show this
count shows nothing.

Fix: count `children.length` (every root *is* a prompt, per the comment at
366-368), or filter on the pre-`labelOf` span name.

### 1.2 `serverIsRunning` is read from state where a ref is needed — HIGH

`src/hooks/use-prompt-mutation.ts:827` calls
`reconnectIfStillRunning(serverIsRunning, reconnectToStream)` in `onSettled`,
reading the `useState` value declared at line 404. That value is written by the
stream's own `onSessionStatus` handler at line 505, during the `await` inside
`mutationFn`. A final `session-status: running` arriving close to settlement can
therefore be invisible to the check that depends on it, and the POST stream is a
one-shot that does not survive a background workflow continuing past the turn —
which is precisely the case `reconnectIfStillRunning` exists for.

The same file already solves this problem the right way three lines apart:
`wikiActiveRef` (line 351) is a ref specifically so that
`onToolCall` can read it synchronously.

Fix: mirror `serverIsRunning` into a ref updated inside `onSessionStatus`, and
read the ref in `onSettled`. `reconnect-if-still-running.test.ts` tests the
extracted predicate in isolation and cannot catch this, so the test wants a
companion that exercises the hook's ordering.

### 1.3 Program cache never sweeps expired entries — MEDIUM

`src/lib/code-map/program.ts` releases a stale entry only on the path that
rebuilds it (line 153). An entry whose `configPath` is never requested again
keeps its TypeScript 7 compiler subprocess alive past `PROGRAM_TTL_MS` until the
process exits. `AGENTS.md` singles out disposal here as load-bearing, and the
module's own docblock says "every path that removes an entry uses it" — true,
but nothing removes entries on a timer or a size cap.

Fix: on insert, sweep and `release()` other entries older than
`PROGRAM_TTL_MS`, or cap the cache at one or two entries.

### 1.4 Workflow maintenance scripts diverge from the path logic they mirror — MEDIUM

`scripts/reconcile-workflow-runs.mjs:55-59` and
`scripts/backfill-stuck-workflow-agents.mjs:39` hardcode
`join(homedir(), ".pi", "workflows", ...)`. Runtime code goes through
`workflowHomeDir()` in `dynamic-workflows/src/workflow-paths.ts`, which honours
`PI_WORKFLOW_HOME`, and `workflow-run-reader.ts:122-145` scans every project key
when the keyed path misses. The script's docblock claims it "Mirrors
workflowRunsDir in workflow-run-reader.ts", which is no longer true.

These are operational scripts, so this is a live footgun rather than cosmetic:
run against a non-default workflow home, they reconcile nothing and report
success.

### 1.5 Unbounded caches — LOW

`src/lib/pi/extensions/read-router.ts:325` holds
`new Map<string, string>()` per bound extension with no eviction, growing one
entry per unique compressed tool result for the session's life.
`src/lib/pi/session/session-stream-store.ts` compacts only `session-status` and
`workflow-snapshot`; spans, deltas and tool markers buffer in full for the
stream's lifetime, which the docblock at 32-40 acknowledges but which matters
more now that background continuations run for minutes.

`WORKFLOW_MANAGER_REGISTRY` was also flagged during the review but is close to a
non-issue: entries are `WeakRef`s, so no manager is retained, and dead keys are
cleared lazily by `getActiveManager`. Only stale string keys for runs never
queried again accumulate.

---

## 2. Code organisation

### 2.1 Two functions hold the system — HIGH

The project's own rule is "large files are discouraged: break up large files into
separate, dedicated files if possible". Two functions are the real violation,
more than the files containing them:

| Function | Location | Lines |
|---|---|---|
| `runWorkflow` | `dynamic-workflows/src/workflow.ts:623-1987` | **1,365** |
| `runPiPrompt` | `src/lib/pi/session/session-service.ts:268-974` | **707** |

Nothing else in the codebase exceeds 300 lines, so these are outliers against
the repo's own norm, not against an external standard.

`runWorkflow` has an unusually clean seam. It builds the workflow DSL as a set of
closures — `phase`, `agent`, `parallel`, `pipeline`, `workflowFn`, `verify`,
`judgePanel`, `loopUntilDry`, `completenessCheck`, `retry`, `gate`,
`checkpoint` — alongside three inline model schemas (`VERIFY_SCHEMA`,
`JUDGE_SCHEMA`, `COMPLETENESS_SCHEMA`), then hands them to a
`vm.createContext`. Every closure reads the same few values (`state`, `shared`,
`logger`, `budget`, `throwIfAborted`). Passing those as one explicit
`WorkflowPrimitiveContext` to a factory per primitive would leave `runWorkflow`
as setup plus context assembly plus `vm` execution, at roughly 200 lines, and
would make each primitive independently testable. The embedded prompts and
schemas belong beside the generated capability docs, not inside the runtime —
`skills/workflow-authoring/references/capabilities.md` already demonstrates that
pattern.

`runPiPrompt` is different: it is wiring, and every step already has a module.
The seams are turn locking and supersession; session and model resolution;
project anchoring and architecture-awareness gating; manifest assembly and the
resource loader; telemetry (`spanPublisher`/`spanSink`/`hostTelemetry` plus flush
scheduling); bridge notifier registration; the agent loop; and end-of-turn
persistence and the wiki stamp sweep. Extracting three or four composers
(`buildTurnRuntime`, `wireTurnTelemetry`, `registerTurnBridges`) would leave the
function as a readable sequence. The 32-line anonymous parameter type at 278-310
should be a named `RunPromptRequest`.

`workflow-manager.ts` (1,736 lines) is the third case, with `createManaged` and
`executeRun` at roughly 325 lines and a persistence cluster at 1212-1368 that
would move cleanly to `workflow-manager-persist.ts`.

### 2.2 `src/lib/pi/` is 91 files deep and flat — HIGH

`src/lib/pi/` holds 91 non-test modules at the top level. The clusters are
unambiguous — 30 `session-*`, 10 `workflow-*`, 9 `review-*`, 4 `git-*`,
4 `wiki-*`, 3 `background-*` — and the folder pattern is already established
next door by `telemetry/`, `file-access/`, `browser-lsp/` and `extensions/`. The
same applies to the 76 flat files in `src/lib/`.

This is the cost of following the small-files rule without a grouping rule: the
files are right and the directory is unnavigable. Grouping into
`pi/session/`, `pi/review/`, `pi/workflow/`, `pi/git/`, `pi/wiki/` is
mechanical, and `@/`-prefixed imports make it a rename rather than a
restructure.

### 2.3 Layering inversions — HIGH

Six `src/lib/` modules import types from a hook:
`workflow-spans.ts:3`, `live-tool-calls.ts:12`, `live-rounds.ts:27`,
`session-steps.ts:29`, `session-live-state.ts:34` all take `SessionMessage` /
`SessionToolCall` from `@/hooks/use-session-messages`. Lib should not depend on
hooks; as it stands this logic cannot be unit-tested without pulling in the hook
graph. `use-session-messages.ts` is only 119 lines and mostly types, so moving
them to `src/lib/session-messages-types.ts` and re-exporting is cheap.

`src/lib/stores/pending-prompt-store.ts:1` imports `PromptEditorModel` from
`@/components/conversation/prompt-editor` — a store whose own docblock says it is
"Kept free of React" importing a presentation type. Both agents flagged this
independently.

Two core modules reach into extension implementations:
`session-service.ts:22-23` imports architecture-awareness settings and
validation directly, and `wiki-repo-stamp.ts:25-43` imports and re-exports
extension modules. `AGENTS.md` treats extensions as factory-loaded participants,
not dependencies of the harness core, so these want a core-facing adapter at the
seam.

### 2.4 Oversized components — MEDIUM

`client-session-component.tsx` (868 lines, one export) owns prompt lifecycle,
review open/follow, workflow snapshot merging, panel layout, pending-prompt
submission, fork state and context-check triggering.
`prompt-input.tsx` (1,474 lines) mixes provider/context (247-372), the core
input (515-949) and about fifteen presentational parts (951-1474) — and the
barrel-file pattern for splitting it already exists at
`ai-elements/prompt-input.tsx`. `session-workflow-panel.tsx` (1,258 lines)
bundles React Flow nodes (110-185), a span detail drawer (218-706) and the panel
itself. Each has clean extraction boundaries listed in the area reports.

### 2.5 Client-side SSE framing duplicated four times — MEDIUM

`src/lib/api/sse.ts` is a genuine success on the server: all five streaming routes
use it and no route hand-rolls `text/event-stream` any more. But it is
server-only, and four client consumers each re-implement
`buffer.split("\n\n")` plus `data:` parsing —
`use-prompt-mutation.ts:158-200`, `use-review.ts:493-513`,
`app-terminal.tsx:147-164`, `code-index-panel.tsx:67-89`. A
`readSseJsonStream<T>(reader, onEvent)` in `src/lib/sse-client.ts` finishes the
job the server half started. The five server routes also still repeat ~40 lines
of `ReadableStream` setup each, which a `createSseResponse({ subscribe })`
helper would absorb.

### 2.6 Three inconsistent API error shapes — MEDIUM

`{ error }` in `api-helpers.ts:36-40` and `files/content/route.ts`,
`{ ok: false, message }` in `git/route.ts:80-127` and `review/route.ts:46-48`.
Clients branch on both. Standardising on one shape is a small change that gets
paid back in every hook.

### 2.7 Duplicated concepts — LOW

`TERMINAL_RUN_STATUSES` is defined in `run-persistence.ts:207` and again as
`IN_MEMORY_TERMINAL_STATUSES` in `workflow-manager.ts:314`, with
`workflow-phase-progress.ts:64-67` holding a third private copy — and
`workflow-run-reader.ts:152-156` carries a comment warning about exactly this
drift. `CompositionBreakdown` is declared twice with different fields
(`context-composition.ts:22-37` has `contextWindowEstimated` and `costPerTurn`;
`context-check/types.ts:22-30` does not), which will confuse the next reader even
though both are currently used correctly.

Two files named `workflow.ts` (`extensions/workflow.ts`, the 461-line extension
factory, and `dynamic-workflows/src/workflow.ts`, the 2,435-line engine) make
greps and review comments ambiguous. Renaming one is free.

---

## 3. Dead code

There is very little, and that is worth saying plainly: no orphaned modules at
all. What exists is concentrated and specific.

**Truly dead — declared and referenced nowhere, including their own file (26):**

- 22 vendored AI Elements components: 11 in `code-block.tsx` (including
  `CodeBlock` itself), 8 in `message.tsx` (`MessageActions`, `MessageAction`,
  the whole `MessageBranch*` family, `MessageToolbar`), plus `FileTreeActions`,
  `NodeAction`, `ConversationDownload`.
- `src/lib/pi/telemetry/workflow-recorder.ts:104` `NO_WORKFLOW_TELEMETRY` — and
  a docblock at `workflow-manager.ts:218` still sends readers to it.
- `src/lib/pi/wiki/wiki-recall-message.ts:27` `WIKI_SESSION_NOTICE_CUSTOM_TYPE`. Its
  docblock says it is "named here so a future caller does not have to rediscover
  the string" — but `transcript.test.ts:117` and `session-file.test.ts:241`
  hardcode `"wiki-session-notice"` instead of importing it, so it already fails
  its own stated purpose.
- `dynamic-workflows/src/enums.ts:46-86`: `ComprehensionSuite`,
  `ComprehensionTaskKind`, `WorkflowAuthoringProtection` and
  `WorkflowReleaseDiagnosticCode` are referenced only by their own companion
  type aliases. The last is left over from `dd6249f [Workflows]: Remove the
  upstream release-check subsystem`.

**Unused API surface:** only 46 of 231 `ai-elements` exports are imported
anywhere, all reached through three one-line re-export shims. `prompt-input.tsx`
exports 81 symbols of which 8 are used. Pruning this is also the cheapest way to
shrink the file.

**Dead HTTP routes (2):** `/api/pi/health` has no client caller — settings reads
`getExtensionHealth()` directly in `extension-health-card.tsx:17` — and its only
mention in `src/` is a comment at `session-service.ts:669`. Full GET/POST
handlers exist at `sessions/[id]/review/uncommit/route.ts:24-74` with nothing
fetching them. Both are defensible as deliberate (an external monitoring
endpoint; an unlanded UI feature), but neither says so.

**Dead prop:** `syncHiddenInput` in `prompt-input.tsx` is documented as working
at line 499-500, declared dead at line 727 ("no longer functional"), still
driving an effect at 729-732, and passed by nobody.

**Over-exported (≈119 symbols):** exported but used only inside their own file.
The query-key constants are the bulk of it (`userSettingsQueryKey`,
`modelTiersQueryKey`, `reviewHunksQueryKey` and a dozen siblings), joined by
`web-tools.ts`'s `htmlToText`/`parseBingResults` and the `code-index` `DEFAULT_*`
constants. Not dead, but a wider public surface than intended.

**A false positive worth recording** so a future pass does not "clean" it:
`src/lib/code-map/call-graph-fixture.ts` exports functions that appear unused
because they exist to be *analysed* by the call-graph builder, not called.

---

## 4. Comment and docblock accuracy

The prose in this repository is unusually good — comments record real bug
postmortems (the TDZ error at `session-service.ts:414`, the wrong session-id key
at 425-431) rather than narrating code. The failures are all drift, and each one
now actively misleads.

### 4.1 Two comments contradict each other about tool exclusion — HIGH

`extension-manifest.ts:339-342` says placement-tools works via
"session-service.ts's excludeTools wiring that keeps Pi's own edit/write out of
the active set". `session-service.ts:604` says "`excludeTools` was tried here
first and is wrong for this", and 595 explains the actual mechanism is Pi's
last-write-wins registry merge. There is no `excludeTools` in
`session-service.ts`. The manifest comment documents the rejected design.

### 4.2 "Nothing reads the spans yet" — HIGH

`session-service.ts:508-510`: "Nothing reads the spans yet — transport and
rendering are the next steps of docs/plans/agent-telemetry.md." Spans are
flushed over SSE at line 530, persisted via `appendSpans` at 531, served by
`/api/sessions/[id]/spans`, and rendered by `session-workflow-panel.tsx` and
`session-agents-panel.tsx`. The whole feature shipped.

### 4.3 Eleven references to a slash command that no longer exists — HIGH

`extensions/workflow.ts:310` documents the removal of `/workflows-models`. Eleven
places still tell operators to run it, and the worst are runtime error strings:
`model-spec.ts:334` and `agent-models.ts:292-293` both emit "Use
/workflows-models to choose an available model" at the moment of failure. Also
`phase-tiers.ts:37,63`, `model-tier-config.ts:254`, `agent-models.ts:55`,
`workflow.ts:489`, `skills/workflow-patterns/SKILL.md:42`,
`model-tier-project-config.test.ts:133`, and `.pi/agents/research.md:20`. The
replacement is `/api/model-tiers`.

### 4.4 A deleted TUI is still described to users — HIGH

The pi-tui deletion removed `task-panel.ts`, `workflow-ui.ts` and
`workflows-models-command.ts`. No code imports them — that was verified — but
user-facing notifications and docblocks still describe a "task panel" and a
"/workflows TUI" that Semla never renders: `saved-commands.ts:48-49,92-97,127`,
`builtin-commands.ts:7,70`, `workflow-tool.ts:331-332`,
`workflow-manager.ts:724,747,855,1664`, `workflow.ts:136-142`. Relatedly,
`workflow-tool.ts:5` still imports `Text` from `@earendil-works/pi-tui` to
render tool calls, which `AGENTS.md` calls dead weight for a harness that
renders no TUI.

### 4.5 `AGENTS.md` says `.pi/` is gone; it is not — HIGH

`AGENTS.md` states it twice, emphatically: "`.pi/` is gone entirely" and "**No
exceptions left, and `.pi/` is gone.**" Two files are tracked in git:
`.pi/workflows/model-tiers.json` and `.pi/agents/research.md`.

`pi-dir-removed.test.ts` is the one that has it right. Its second docblock
explains that the directory name is not forbidden — `.pi/worktrees/` is used by
dynamic-workflows, `.pi/agents/` is a convention pi reads, and
`.pi/workflows/model-tiers.json` is a deliberate repo-local override — and the
test forbids only `settings.json`, `npm/` and `packages/`. The prose has drifted
past its own guard. `.oxlintrc.json` has drifted the same way, still ignoring
`.pi/**` as "Sibling dependency trees and their build output" when `AGENTS.md`
says there is one tree now.

### 4.6 Smaller drift — MEDIUM

- `session-service.ts:395-399` duplicates the paragraph at 415-418 verbatim, and
  in the first position it sits above an unrelated declaration.
- `session-service.ts:251-253` cites "the 5s workflow-runs reconciliation poll".
  `use-workflow-runs.ts:52` polls at 2s; `background-continuation.ts:149` cites
  2s correctly. The 5s figure belonged to the old `/status` poll.
- `agent-dir.ts:23-25` justifies placing `PI_AGENT_DIR` outside the repo because
  "`.pi/` is tracked in git" — a reason that no longer holds in the form stated.
- `use-prompt-mutation.ts:375-388` points at "session-reconnect.ts's own
  history"; that file does not exist.
- `reconcile-workflow-runs.mjs:54` claims to mirror `workflowRunsDir`; see 1.4.
- `runtime-config.ts:182-184` and `session-service.ts:674-676` describe
  project-scope `.pi/settings.json` loading in a way that is accurate about pi
  but misleading about this repository.
- `extension-reload.ts:41` keys its handoff symbol on
  `@quintinshaw/pi-dynamic-workflows`, which is no longer a declared dependency.

---

## 5. Two policy questions

These are not defects; they are decisions that have quietly expired and should
be re-made deliberately.

### 5.1 15% of `src/` is exempt from lint on a premise that no longer holds

`.oxlintrc.json` ignores `src/lib/pi/extensions/dynamic-workflows/**` as
"Third-party source inlined from @quintinshaw/pi-dynamic-workflows; not subject
to this project's lint rules." That is 63 files and 17,579 lines — about 15% of
`src/` — and it contains the two largest files in the repository.

The premise has expired. 60 commits touch that tree, including
`[dynamic-workflows]: split agent.ts into runner plus five auxiliary modules`
and `[dynamic-workflows]: unit-test the functions extracted out of agent.ts`.
`@quintinshaw/pi-dynamic-workflows` is not a declared dependency; the directory
keeps its own `package.json` pinning 3.5.1 and its own `README.md` inside
`src/`. This is a maintained fork, not vendored third-party source.

The consequence is specific: this code is exempt from the type-aware rules
`AGENTS.md` describes as the interesting ones for a traceability harness — above
all `no-floating-promises`, since "a floating promise is work that silently did
not happen", which is exactly the failure mode of a workflow engine. `tsc` still
covers it (`tsconfig.json` includes all of `src/**`) and its tests run, so this
is a lint gap rather than a void.

Either turn the lint on and work the findings down, or keep the exemption and add
a version-pinning contract test in the style of `wiki-package-contract.test.ts`
so the fork's provenance is asserted somewhere. Right now it is neither
third-party nor first-class.

### 5.2 The security model is stated twice, with two different conclusions

21 of 54 API routes never check session ownership, including every
`sessions/[id]/review/*` handler (`stage`, `commit`, `uncommit`), `files/content`,
`files`, `git`, and the `wiki`/`projects` routes. The other 33 call
`requireSessionOwner`, whose `allowMissing` option carries a careful nine-line
rationale about a real captured flow.

`review-service.ts:11-14` is candid about why: "Semla is single-user and
loopback-bound, so this is not a defence against a remote attacker. It is a
defence against a bug in the panel pointing a commit, a write, or a reset at the
wrong repository." Path containment is genuinely well done — `resolveReviewTarget`
derives the repo from the session's own links, and `resolveReviewFile` uses
`relative` rather than a prefix test, with a comment noting that `/Dev` prefixes
`/Devil`.

But `auth-mode.ts` and `README.md:80` both document the exposed mode:
`SEMLA_BIND_HOST=0.0.0.0` turns Supabase authentication on, and
`docs/plans/session-projects.md:528` already reasons about what "any signed-in
user" could reach. In that supported configuration, a signed-in user who knows a
session id can stage, commit and reset another user's working tree, and read any
file in their projects.

So either the exposed mode is real — and these 21 routes need
`requireSessionOwner`, which is a one-line change each — or it is not, and the
ceremony on the other 33 is misleading. The current state documents both
positions in different files.

---

## 6. What is working

Worth recording so it does not get refactored away:

- **`src/lib/api/sse.ts`** — a clean consolidation, fully adopted server-side.
- **The client/server split in `context-composition.ts`** — the docblock explains
  exactly why the arithmetic is client-safe and only `modelContextWindow` stays
  in `lib/pi`, and names the test that enforces it. The identical filename across
  layers is the only cost.
- **`auth-mode.ts`** — deriving the auth policy from the bind address rather than
  the `Host` header, with the reasoning written down, is a better decision than
  most codebases make here.
- **`pi-dir-removed.test.ts`** — a guard that explains not just what is forbidden
  but what is deliberately still allowed. It is more accurate than the
  `AGENTS.md` section it implements.
- **Extension loading** — declared in a manifest, ordered, verified on load, with
  the path-vs-factory distinction and the "path extensions load before factories"
  constraint both documented and tested.
- **`code-index/` vs `code-map/`** — checked for overlap; there is none. Different
  tools, different outputs, no cross-imports.
- **Test coverage** — 2,524 tests, and the interesting ones test reasoning
  (`extension-contract-concurrency`, `manifest-anchor-gating`,
  `wiki-package-contract`) rather than just lines.

---

## 7. Suggested order

1. **1.1** `semla.session.prompts` — a one-line fix to a feature that currently
   displays nothing.
2. **1.2** `serverIsRunning` ref — user-visible: a background workflow can fail
   to reconnect.
3. **5.2** Decide the auth question, then apply it. If the exposed mode stays,
   this is 21 one-line additions.
4. **4.1–4.5** The misleading comments, especially the two that contradict each
   other and the eleven `/workflows-models` references that reach users at
   failure time.
5. **5.1** Decide the lint exemption question.
6. **1.4** Fix the workflow scripts before their next operational run.
7. **2.3** Move `SessionMessage`/`SessionToolCall` and `PromptEditorModel` into
   `lib`, un-inverting five files at once.
8. **3** Delete the 26 dead symbols and the 2 dead routes; prune the unused
   `ai-elements` surface, which shrinks `prompt-input.tsx` as a side effect.
9. **2.2** Group `src/lib/pi/` into subfolders — mechanical, and makes everything
   after it easier to navigate.
10. **2.1** Split `runWorkflow` along its primitive seams, then `runPiPrompt`
    along its wiring seams. Largest effort, highest long-term return.
11. **1.3, 1.5, 2.4–2.7** Cache disposal, component splits, SSE client helper,
    error-shape unification, de-duplicated status sets.
