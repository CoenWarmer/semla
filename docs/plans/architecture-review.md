# Architecture review: code organisation and the Pi↔Semla seam

**Goal:** record what a full-codebase architecture review found, worst first, so
each item can be picked up on its own. The emphasis was on the connecting pieces
between Pi extensions and Semla, with general code organisation second.

**Status:** reviewed 2026-09-15. §2, §3, §4, §5, §7 and §8 are done and landed;
§6 is what remains. Every finding was verified directly against the files and is
cited with line numbers — though see §5.3 for one that was verified against the
wrong layer and came out backwards.

One caution about method, because it cost time here and will again. Two of the
review's surveys were delegated, and one returned a finding — SSR seed drift on
the session page — that was **already fixed**; the agent had been served a stale
copy of `sessions/[id]/page.tsx`, as was the file-read tool when checking the
claim. The current file is 74 lines and calls `buildSessionMessages`, with a
comment explaining exactly why the whole payload must be seeded. Line numbers
from a delegated survey are a lead, not evidence. §7 records what survived
checking.

**Baseline at time of review:** `npm run tsc` clean, 2502 tests passing across
225 files, `npm run lint` reporting nine errors (§8). Everything below is a
finding about design, not a broken build.

---

## 1. The shape of it

The Pi↔Semla seam is *designed* rather than accreted, and that is worth saying
before the list of problems. `extension-manifest.ts` turns extension loading
from a hopeful array of paths into a verified operation: topological ordering
from declared `requires`, pre-load path checks, post-load verification of every
tool and contract slot an extension claimed, and a remedy string attached to
each possible failure. `assertManifestIsCoherent` catches the non-obvious
constraint that Pi loads every path extension before any factory — a class of
bug that would otherwise surface as a slot read as `undefined`.
`extension-contract.ts` makes the `globalThis` symbol protocol a single typed
declaration site and correctly identifies that the key strings are a wire format
with an out-of-repo consumer. `runtime-config.ts` derives every path into a
third-party package from one constant.

The problems fall into four groups, and the grouping is the useful part:

1. **Session-scoped state kept in process-global slots.** All three instances
   are now fixed (§2, §3.1, §3.3). The failure mode was always silent, and
   always cross-session. §3.1 is the one that could not simply be keyed — its
   caller is outside this repository — so the session is passed to it instead.
2. **Comments that are no longer true** (§4). Ordinarily cosmetic; in a harness
   whose product is traceability, a docblock asserting a test suite that does not
   exist is worse than the code it describes.
3. **A vendored subsystem that never got assimilated** (§5, §6), which was
   carrying ~2500 lines of TUI that Semla's `print` mode cannot render. §5 is
   done and they are gone; §6 is the half that remains.
4. **Directory organisation that stopped scaling** (§6), where the convention
   already exists and was applied to the three smallest subsystems.

---

## 2. Done: session-keyed contract slots

`ACTIVE_WORKFLOW_MANAGER` and `BRIDGE_RUN_STARTED` were process-global while
being session-scoped in meaning. Semla runs sessions concurrently by
construction — `session-turn-lock.ts` keys its registry by session, so it
serialises turns *within* a session and deliberately does not across them, which
is the concurrency `session-concurrency.ts` exists to surface.
`WIKI_SESSION_REPOS` was keyed from the start and its docblock explains exactly
why; the other two were not.

Two failures followed, both silent. A second session publishing its manager or
notifier replaced the first's, so a wiki ingest dispatched by session A ran on
B's manager and its run was announced to B's event router. And the turn-end
clear took the whole slot, so whichever of two concurrent turns ended first
removed the other's notifier — after which `readSessionSlot(...)?.(runId)` is an
optional call that no-ops, so that session's background runs reported no progress
at all, with nothing logged and nothing thrown.

Both slots are now keyed by pi session id — `sessionManager.getSessionId()`, the
only identity all four participants can see. `extension-contract.ts` gained
`SESSION_KEYED_SLOT_KEYS` and `writeSessionSlot` / `readSessionSlot` /
`clearSessionSlot`, with a `SessionValue<K>` conditional type so each slot keeps
its own payload type through the generic helpers. Two details are load-bearing:

- The manager is a `WeakRef`, matching `WORKFLOW_MANAGER_REGISTRY`. It cannot be
  cleared at turn end, because `runBackgroundContinuation` starts *inside* the
  turn's `finally` and still drives the agent, so a continuation's wiki ingest
  needs it after the turn is over. A strong entry would instead retain one
  manager per session for the life of the server. The extension's own factory
  closure (`let manager`, `extensions/workflow.ts:204`) keeps it alive exactly as
  long as the session.
- The clear is identity-guarded, the same guard and for the same reason as
  `TurnSlot.finish()`, so a superseded turn's `finally` cannot delete the
  notifier belonging to the turn that displaced it.

Load verification got stronger rather than weaker: `buildExtensionLoadReport`
takes `piSessionId` and checks keyed slots for *that* session, so a concurrent
session's entry cannot satisfy this session's check. All per-slot knowledge lives
in `isSlotPublished`, which shape-checks (`instanceof Map`, `instanceof WeakRef`)
instead of casting — the slots are reachable by string from any module, and a
wrong shape should surface as "loaded but did not publish contract slot" with the
extension's remedy attached, not as a `TypeError` thrown out of the report.

`extension-contract-concurrency.test.ts` pins both failure modes.

---

## 3. Correctness: the same bug, twice more

**1. The wiki dispatcher slots. — FIXED.** `WIKI_INGEST_DISPATCHER` and
`WIKI_REINDEX_DISPATCHER` were written per session by the bridge with no key, so
last writer wins and session A's ingest ran through B's dispatcher and was
attributed to B's repo. The same defect as §2, but the fix could not be the same
one: `@zosmaai/pi-llm-wiki` reads both by literal at
`extensions/llm-wiki/lib/tools.ts:403` and `:1224` and calls them as plain
functions, so it cannot index a session map — and teaching it to would put the
key format itself into the wire contract.

So the session travels as an *argument* instead. The patch passes
`ctx.sessionManager.getSessionId()` at both call sites, and the dispatcher
resolves the workflow manager, the run notifier and the repos from that id
rather than from the instance that happened to write the slot. The closures
become session-agnostic, which is what makes last-writer-wins over the slot
harmless: keyed state behind an unkeyed entry point, which is the only shape an
external caller can satisfy. Both tools are withheld from subagents
(`WIKI_TOOLS_WITHHELD_FROM_SUBAGENTS`), so the calling ctx is always the host
session's and the id is the one the bridge would have closed over.

Two things needed care. The patch had to be re-cut rather than hand-edited —
`apply-package-patches.mjs` checks a reverse-apply first, so an edited patch
matches neither the pristine nor the patched tree and fails the install; it was
regenerated from a pristine extraction and verified to round-trip. And a
dispatch with no session id has to keep working, because that is what an
unpatched package does: it falls back to the registering session, which is right
for a lone session and wrong for concurrent ones, and warns once rather than
degrading quietly.

`wiki-package-contract.test.ts` now asserts the argument as well as the symbol —
verified to fail with the patch reverted, since both are silent losses. The
concurrent-dispatch cases in `wiki-ingest-bridge.test.ts` pin that a dispatch
reaches the calling session's manager and notifier and not the slot owner's, and
that the unpatched fallback is loud. Those tests also removed nine copies of an
inline dispatcher cast, which is why the single-session cases now read as
`ingestDispatcher()`.

One thing this did *not* settle: the `ingest-worker.ts` half of the patch edits
the package's TypeScript source, but the bridge deep-imports
`dist/extensions/llm-wiki/lib/ingest-worker.js` for `commitSynthesis`. If the
shipped `dist/` is not rebuilt from the patched source, that half of the patch
affects nothing the bridge calls. Untouched here because it is a separate
question from the dispatcher keying, but it is worth an hour.

**2. `workflow-manager.ts:668` bypasses the contract. — FIXED.** It re-declared
`Symbol.for("semla.workflow.managers")` as a literal and wrote it through raw
`globalThis`, while `workflow-manager-registry.ts:11` read the same slot through
`readOrInitSlot`. Only the reader went through the single declaration site, so a
typo on the writer side would silently break live snapshot merging in the
workflow panel — the exact failure the contract module was written to make
impossible. The reason it was missed is that the writer lives in the vendored
tree, where `@/` imports are absent by convention.

It now calls `readOrInitSlot(WORKFLOW_MANAGER_REGISTRY, ...)`, imported
relatively. That is the vendored tree's only host *value* import, and it is
safe because `extension-contract.ts` imports nothing at all, so the module stays
loadable on its own — jiti included. The registry assertion in
`workflow-manager.test.ts` deliberately keeps spelling the raw string: it
observes `globalThis` from outside, so it now pins that the contract symbol is
what actually lands there.

**3. `ask-user-bridge.ts` and `feature-spec-bridge.ts` are a parallel
mechanism. — FIXED.** Each declared its own pending/notifier symbol pair outside
the contract — `semla.ask-user.pending` and `semla.ask-user.notifiers`,
`semla.feature-spec.pending` and `semla.feature-spec.notifiers` — and the two
files were near-duplicates at ~100 lines apiece, the second's docblock saying
"Same shape as ask-user-bridge.ts". So this was one missing abstraction plus two
bypasses. Both docblocks cited `workflow-progress-bridge.ts` as the precedent
they followed; that file does not exist.

The shape they share is a per-session request/response rendezvous between a tool
`execute()` and an HTTP route. It now exists once, as
`createSessionRendezvous` in `session-rendezvous.ts`, over two contract slots
(`ASK_USER_RENDEZVOUS`, `FEATURE_SPEC_RENDEZVOUS`). Each slot holds
`{ notifiers, waiting }` together, because a slot holding half the state is not
a state a caller can use. The bridges are now 55 and 46 lines: their own types,
one instantiation, three re-exports. No consumer signature changed.

Consolidating found a defect both copies had. A second `waitFor` for one
session overwrote the pending entry, leaving the displaced promise unsettled
forever — and it is awaited inside a tool's `execute()`, so the failure mode was
a wedged agent loop, not a lost answer. The shared copy rejects the displaced
call instead. Turns are serialised per session so it should not arise, which is
why it could sit there unnoticed.

It also settled a question the contract had answered wrongly. `SessionKeyedSlotKey`'s
docblock said the key is the pi runtime session id and "not the Semla session
id". Those are the same *value*: `createSessionFile` names the pi session file
after the Semla session id and writes it into the session header, which is where
pi reads `getSessionId()` from, and Semla only ever moves the leaf pointer
(`branch`, `resetLeaf`) rather than calling `createBranchedSession`, which is
the one operation that would reassign it. That equality is what makes these two
bridges correct at all — they register under the Semla id and are looked up by a
tool holding pi's. The docblock now says so; the real distinction it was
reaching for is against the `pi_sessions` row id.

`session-rendezvous.test.ts` pins the per-session isolation, both abort paths,
the displacement rejection, the identity-guarded unregister, and that two
instances over one slot share state — which is the arrangement the process
actually has when the tool side and the route side load the module separately.

---

## 4. Comments that are not true

**1. `workflow-ui.ts` claimed tests it did not have. — FIXED by deletion.** Its
header stated "The state machine and line rendering are pure and unit-tested".
There were no tests for `keyToAction`, `renderNavigator` or `NavigatorModel`
anywhere in the repository — the only file matching those names was
`workflow-ui.ts` itself. §5 removed the file, which settles it.

**2. `runtime-config.ts` has an orphaned docblock.** Lines 152–159 describe "Pi
session transcripts, one .jsonl per Semla session" and sit directly above
`GIT_FETCH_INTERVAL_MS`'s own docblock, while the constant they document,
`PI_SESSION_DIR`, is declared at line 173. A reader gets the wrong explanation
for the wrong constant.

**3. `dynamic-workflows/README.md` describes a different product.** 26KB of
upstream npm README presenting the `/workflows` TUI navigator and task panel as
the primary interface, plus `pi install npm:@quintinshaw/pi-dynamic-workflows`
instructions that do not apply. Semla drives this subsystem through
`workflow_control` and its own React panel. §5 corrected the parts that named
commands it deleted — the command table, the navigator keybindings, the
instruction to edit model tiers interactively — because leaving those would have
documented a surface that no longer exists. The rest of the overhaul stands.

**4. `pi-dir-removed.test.ts`'s docblock is incomplete.** It enumerates
`.pi/worktrees/` and `.pi/agents/` as the legitimate remaining uses of the
directory; `.pi/workflows/model-tiers.json` also exists and is not mentioned. The
test itself is correct — it forbids only `settings.json`, `npm` and `packages` —
so this is one line of prose.

**5. Fixed during §2:** `wiki-ingest-bridge.ts`'s `repoOf` comment asserted the
bridge could not resolve the `@/` alias, when it is a factory that imports
through it at the top of the same file. Left over from before it migrated from
path-loading.

---

## 5. Done: the TUI surface is gone

Semla calls `session.bindExtensions({ mode: "print" })`
(`session-service.ts:641`), and Pi's own extension docs record that `print` mode
leaves `ctx.hasUI` false with UI methods as no-ops. Three consequences were
claimed here. Two were right; the third was wrong, and being wrong about it was
nearly expensive, so it is written up rather than quietly corrected.

**1. `workflow-ui.ts` was unreachable. — FIXED.** All 2241 lines were reached
only through `openWorkflowNavigator`, guarded on `ctx.hasUI`. Deleting it meant
relocating the 8-line `shortModel`, which went to `display.ts`. That relocation
turned out to be a stepping stone: `shortModel`'s only caller was the task panel
in item 2, so once that went, `shortModel` had no callers at all and has been
deleted too.

**2. The task panel widget was a no-op with no guard. — FIXED.**
`installTaskPanel` ran on every `session_start` and called `ui.setWidget(...)`
with a `@earendil-works/pi-tui` factory unguarded. A `ctx.hasUI` guard was the
first fix, but a guard that is always false is just a longer way to write dead
code, so `task-panel.ts` has been split on the line the review identified:
`installResultDelivery` and its helpers are live and essential — they deliver
background results over `pi.sendMessage` and never touch the TUI — and are now
`result-delivery.ts`. The 265 lines of widget rendering are gone.

That deletion had a tail nobody predicted. `/workflows-progress` set
`progressPanelMode` and `progressPanelMaxAgents`, and the panel was the only
thing that read them. With it gone the command persisted a setting, read it back
and reported it — a command that looked like it worked and configured nothing.
It is gone, with both settings and their validation; a settings file still
carrying the keys is ignored rather than rejected, since a stale key is no reason
to fail a read. `/workflows-trigger` is the mirror image and stays: its settings
feed the `input` hook, which is live precisely because it fires on ordinary
messages instead of needing a UI.

**3. "Slash commands are registered but unreachable" was false.** The claim was
that `/workflows`, `/deep-research` and the rest have no path from the web UI.
They do. `AgentSession.prompt()` dispatches extension commands itself —
`agent-session.js:799` tests `text.startsWith("/")` and calls
`_tryExecuteExtensionCommand` — and that is in `prompt()`, which the package's
own comment describes as shared across interactive, print and rpc. Semla's
prompt route trims the text and passes it through untouched, so typing
`/workflows stop <id>` into the prompt bar really does stop the run. What is
TUI-only is Pi's *built-in* commands (`/model`, `/settings`), which are handled
in `interactive-mode.js` before `prompt()` is ever reached and are not
`registerCommand` contributions at all. Acting on the original claim would have
deleted working functionality.

The narrower defect underneath it is real but different: a handler is dead when
it depends on the UI methods that `print` mode stubs, not merely because it is a
command. Exactly one qualified. `/workflows-models` was a 247-line pi-tui tier
editor in which every branch ran through `ctx.ui.select`/`custom`/`confirm`;
`select` returns `undefined` under `noOpUIContext`, so the menu loop broke on its
first iteration and the command did nothing whatsoever, silently. It is deleted —
Semla edits tiers over `/api/model-tiers` — and with it the last `pi-tui` import
outside the one properly guarded use in `workflow-tool.ts`. Every other command
uses only `pi.sendMessage` and real side effects, and works.

**What this leaves (new, and not yet done): `ctx.ui.notify` is silent.** Some 36
call sites across `workflow-commands.ts` (20), `builtin-commands.ts` (11),
`saved-commands.ts` (4) and `extensions/workflow.ts` report progress, warnings
and errors through `ctx.ui.notify`, which is a no-op in `print` mode. So the
commands do their work and say nothing. Mostly that is a missing confirmation,
but where `notify` is the *only* output the command is indistinguishable from
broken — `/workflows run` with an empty prompt sends `RUN_USAGE` to `notify` and
returns, so it appears to do nothing at all. This is its own change, with real
content (`notify` carries a severity that `sendMessage` has no slot for, and some
sites are already followed by a visible `sendMessage`), so it is recorded here
rather than folded into this section.

---

## 6. Code organisation

**1. `src/lib/pi/` is flat, and the convention for fixing it already exists.**
89 non-test modules in one directory: 29 `session-*`, 10 `workflow-*`, 9
`review-*`, 4 `git-*`. Meanwhile `telemetry/`, `file-access/` and `browser-lsp/`
*are* subdirectories. So the directory convention was applied to the three
smallest subsystems and not to the three largest, and the prefixes are already
the folder names. Worth noting before anyone starts: `client-boundary.test.ts`
walks the import graph and several modules are deliberately node-free for it, so
a move must keep the `review-types.ts`-style split modules where client code can
still reach them.

**2. `runPiPrompt` is one ~700-line function** (`session-service.ts:268` to the
end of a 974-line file), with roughly 40 documented sequential steps and 48 lines
at four-plus indent levels. The file docblock frames this deliberately — "This
file is the sequence" — and the per-decision commentary is genuinely good, much
of it recording a real failure. So this is a judgement call rather than a defect,
but it sits against AGENTS.md's own "large files are discouraged", and the
existing `phase(...)` calls are a ready-made seam: each names a step that could
be a function taking an explicit context object.

**3. Three files over 1000 lines in `dynamic-workflows/src/`.** `workflow.ts`
(2435) mixes the VM runner, every orchestration primitive — `agent`, `parallel`,
`pipeline`, `verify`, `judgePanel`, `retry`, `gate`, `checkpoint` — and the Acorn
script parser in one file; supporting modules have been extracted around it but
the core runner stayed monolithic. `workflow-manager.ts` (1735) owns lifecycle,
persistence scheduling, in-memory eviction, event emission and the registry.
`workflow-capability-contract.ts` (1016) is the exception and is justified: it is
data rather than logic, and it generates the README's capability table. There
were four: `workflow-ui.ts` (2241) was the largest and §5 deleted it.

**4. Vendored upstream, never assimilated.** `dynamic-workflows` still carries
`@quintinshaw/pi-dynamic-workflows`' `package.json`, which is not a declared
dependency of this repository and is read only for a version string in
`extension-reload.ts`. Git history shows the inlining: `16c7a4b` "[Pi]: Inline
dynamic-workflows source into src/lib/pi/extensions/" and `0c3ebfd` "[Workflows]:
Import the workflow subsystem directly, and drop its barrel". The encouraging
half, and it is a real strength: the subtree has **zero** imports back into `@/`
app code, so it is a clean one-way dependency.

**5. Naming collision.** `extensions/workflow.ts` (464 lines, the Semla adapter
registered in the manifest) versus `extensions/dynamic-workflows/src/workflow.ts`
(2435 lines, the engine). The adapter/engine split itself is principled and the
adapter is appropriately thin; only the names collide. `workflow-extension.ts`
for the former would settle it.

**6. Two crossings that blur the vendored boundary.** `read-router.ts:23` imports
`loadWorkflowSettings` from `dynamic-workflows/src/workflow-settings.ts`, so a
Semla extension reads its configuration out of the vendored tree. And
`model-tier-editor.tsx` — a client component — imports
`dynamic-workflows/src/model-spec.ts`. Both pass today; neither is where the
boundary should be.

---

## 7. The Next.js layer

Routes are thin adapters over `src/lib/` by default, which is the correct shape,
and `client-boundary.test.ts` is a real strength: it walks the *transitive*
import graph from every `"use client"` file rather than checking direct imports,
which is what catches a multi-hop leak.

Each item below was checked against the files. One lead from the same survey did
not survive checking and is recorded at the end of this section so it is not
raised again.

**1. `context-check/route.ts` is 372 lines and exports its types.** It holds an
algorithm (`computeCorrectionRate`, `buildCompactTranscript`), an LLM inspector
prompt and `runInspectorLlm`, and exports five types — `DimensionLevel`,
`DimensionScore`, `CompositionBreakdown`, `ContextCheckResult` and
`StoredInspection`. Two client modules import from the route file itself:
`use-context-check.ts:2` and `inspector-panel.tsx:12`. Wants to be
`src/lib/context-check/` with a client-safe types module, on the
`review-types.ts` pattern.

**2. SSE boilerplate is reimplemented five times** — encoder, `data: …\n\n`,
30-second heartbeat, abort and close guards — in `code-index/stream`,
`terminal/[id]`, `sessions/[id]/prompt`, `sessions/[id]/stream` and
`sessions/[id]/review/lsp/diagnostics`.

**3. Response conventions are mixed.** `Response.json` appears in 55 route files
and `NextResponse.json` in 24. Error bodies come in three shapes: `{error}` from
`api-helpers.ts`, and `{ok:false,message}` with the two key orders across six
route files (`sessions/[id]/git`, `projects/git`, and four under
`sessions/[id]/review`).

**4. The SSE wire type is duplicated rather than shared.** `PiStreamEvent` is
re-declared client-side at `use-prompt-mutation.ts:82` against the canonical
`PiSessionEvent` at `session-events.ts:19`. The hook carries a comment
acknowledging the duplication is deliberate and that each new variant costs two
edits.

**5. God components and hooks.** `client-session-component.tsx` (877),
`prompt-input.tsx` (1474), `session-workflow-panel.tsx` (1258),
`review-panel.tsx` (755); `use-prompt-mutation.ts` (873), `use-review.ts` (592).
`client-session-component.tsx` is the one that matters most, because every
session feature has to touch it.

**6. 21 of 54 routes never call `requireUser` or `requireSessionOwner`**,
including the review cluster, file read/write and git actions. This is a
documented trade-off, not an oversight — `review-service.ts:11` records that
Semla is single-user and loopback-bound and that path containment is the actual
defence — but it is the assumption that breaks first if the deployment model
changes, so it belongs here as a known condition rather than a bug.

**7. `"use client"` is inconsistent across hooks:** 7 of 30 carry it
(`use-review.ts` does, `use-prompt-mutation.ts` does not). The boundary
therefore relies on importers rather than being self-declaring.

**Checked and already handled — do not re-raise.** SSR seed drift on the session
page. `sessions/[id]/page.tsx:26` calls `buildSessionMessages`, the same builder
the messages route uses, and carries a comment explaining why: the payload is
seeded as the query's `initialData`, "and a query with initialData does not
refetch while it is fresh — so a field missing here is missing on screen."

---

## 8. Hygiene

`npm run lint` reports nine errors, five of them React Compiler rules — which per
AGENTS.md are precisely the ones that mean a component has fallen out of the
compiler's reach, and the config raises `jsx-a11y` and `nextjs` findings as
warnings specifically so a real one is not buried:

- `react(static-components)` — `ai-elements/shimmer.tsx:51`
- `react(refs)` ×3 — `ai-elements/code/code-block.tsx:277,278,280`
- `react(set-state-in-effect)` — `hooks/use-mobile.ts:14`
- `eslint(no-unused-vars)` — `conversation/prompt-editor.tsx:212`
- `typescript(restrict-template-expressions)` ×3 — `ui/chart.tsx:154,202,301`

The last three are in shadcn-generated code, so they are a question of whether to
suppress at the file or fix in place. The first five are not.

---

## 9. Suggested order

**Small and independent, a session's worth together:** ~~§3.2 (the
`workflow-manager.ts` literal)~~, ~~§4.1~~, ~~§4.2~~, ~~§4.4~~ (the untrue and
incomplete comments), ~~§5.2~~, ~~§8~~ — done. **§6.5 (the rename) is not**, and
an earlier revision of this line wrongly said it was:
`extensions/workflow.ts` still sits next to `dynamic-workflows/src/workflow.ts`.

**Then the ones with design content, roughly in this order:**

1. ~~**§3.1 — key the wiki dispatcher slots.**~~ Done, though not by keying
   them: the caller is out of repo, so the session is passed instead. It was
   the last silent cross-session path.
2. ~~**§5 — delete the TUI surface.**~~ Done, and smaller than budgeted because
   only one of the three items was a bulk deletion. Worth reading §5.3 before
   trusting a "this is unreachable" claim in this document again.
3. ~~**§3.3 — one session-keyed rendezvous**~~ replacing both bridges. Done.
4. ~~**§7.1 and §7.2 — extract**~~ the context-check module and a shared SSE
   helper. Done.
5. **§6.1 — group `src/lib/pi/`.** Best done when no other large change is in
   flight, since it touches every import path. **This is the next one**, unless
   the `ctx.ui.notify` silence at the end of §5 is judged more urgent — that one
   is user-visible and this one is not.

§6.2 (`runPiPrompt`) and §6.3 (`workflow.ts`) are deliberately last. Both are
load-bearing concurrency-sensitive code whose comments record real incidents, and
neither is causing a problem today.

**Residuals from §5, deliberately not taken.** `createWidgetWorkflowDisplay`
(`display.ts:208`) is also a pi-tui widget Semla never renders, but it is
correctly `hasUI`-guarded and sits behind `createToolUpdateWorkflowDisplay`,
which is the live path. It costs a closure per run, not a failure mode. The
`renderCall`/`renderResult` hooks on the `workflow` tool
(`workflow-tool.ts:417`) are the last `pi-tui` import in `src/`: they are
declarations Pi calls only when it has a TUI, and `renderResult` shares
`renderWorkflowText` with the live tool-update path, so removing them would buy
one import and cost that symmetry. Four
`behaviorEvidence` entries in `workflow-capability-contract.ts` also still point
at a `tests/` directory that does not exist in this repository — upstream-relative
leftovers from the vendoring, unvalidated by anything. The fifth named the file
§5.3 deleted and now points at a test that exists.
