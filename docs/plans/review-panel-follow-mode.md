# Plan: ReviewPanel follow mode

Auto-open the Review panel on agent edits, and follow the agent's file/line in the editor.

## Decisions (settled with the operator, do not re-open)

- Only mutating tools (`edit`, `write`) **open** the panel. Read-type tools navigate it only if already open.
- Follow behaviour is a user-controllable **Follow mode** toggle, default ON, persistent.
- Scope includes **live follow** and **historical replay** (clicking a past tool call jumps the editor).

## 1. Summary

Today the Review panel opens only *after* a turn ends — [`shouldOpenReview`](src/lib/review-open.ts) returns `false` while `sessionRunning`. The only way to point it at a file/line is `ReviewPanel`'s `initialTarget` prop, which the panel reads **once, on mount**, so [`ClientSessionComponent`](src/components/client-session-component.tsx) forces a remount with `key={elementTarget.target?.nonce ?? "manual"}` (line 722–726).

That mechanism cannot carry a follow stream: remounting on every tool call would discard `drafts`, `expanded`, `selectedCommitSha` and editor scroll. So this plan:

1. introduces a session-scoped **follow target** mirrored into the TanStack Query cache next to the existing live-turn state in [`session-live-state.ts`](src/lib/session-live-state.ts), derived in `usePromptMutation`'s `onToolStart`/`onToolEnd` from the same `LiveToolEvent` shape `applyLiveToolEvent` already consumes;
2. converts `ReviewPanel` from mount-only `initialTarget` to a **nonce-compared, render-derived** target, so a new target changes file + reveal line without a remount and without setting state from an effect;
3. gates opening on `edit`/`write` only;
4. adds a persisted Follow-mode toggle to [`SessionTopbar`](src/components/session-topbar.tsx);
5. reuses the same pure "tool call → target" function for replay from [`SessionStepsStrip`](src/components/session-steps-strip.tsx).

## 2. Architecture

### 2.1 State shape

New pure module — `src/lib/review-follow-target.ts` (nothing like it exists):

```
export type FollowTarget = {
  project: string;   // workspace-relative project path, as ProjectReview.path
  path: string;      // project-relative, as ChangedFile.path / FileSelection.path
  line: number;      // 1-based; 1 when nothing better is known
  nonce: number;     // strictly increasing per session
  origin: "mutate" | "read" | "replay";
};
```

`origin: "mutate"` is the only one that may **open** the panel; `"read"` and `"replay"` only navigate an open one. The asymmetry is encoded once, in a pure function, rather than at three call sites.

Exports: `followTargetFromToolCall(call, projects)`, `isMutatingTool(name)`, `firstGrepHit(resultText)`, `shouldFollowOpen(target, followMode)`, `followModeEnabled(settings)`.

`isMutatingTool` must agree with `writtenPath` in [`session-project-attach.ts`](src/lib/pi/session-project-attach.ts), which already defines mutating as exactly `edit` and `write`. A test pins the agreement.

Carrier — modify [`session-live-state.ts`](src/lib/session-live-state.ts): add `sessionFollowTargetKey(sessionId)` and `useSessionFollowTarget(sessionId)` following the existing `sessionLiveToolCallsKey` / `sessionActiveToolKey` pattern (`queryFn` returning the empty value, `staleTime: Number.POSITIVE_INFINITY`).

**No new React context.** `ElementTargetProvider` exists because `ElementPicker` and `ClientSessionComponent` are siblings; here the producer (`usePromptMutation`, inside `ClientSessionComponent`) and consumer (`ReviewPanel`, a descendant) are not, and the query-cache mirror already covers the replay case.

### 2.2 Data flow, live

1. [`session-event-router.ts`](src/lib/pi/session-event-router.ts) `onToolStart` emits `tool-start` with `params = getParams(event.args)` — scalars only, so `path`, `offset`, `limit`, `pattern` survive. No change needed.
2. `onToolEnd` carries `resultText` only — insufficient for `edit`'s `firstChangedLine`. See §3 and Phase 2.
3. [`use-prompt-mutation.ts`](src/hooks/use-prompt-mutation.ts) handlers already fold events into `liveToolCalls` and mirror to the cache. Add one `queryClient.setQueryData(sessionFollowTargetKey(sessionId), …)`, computing the target and incrementing `nonce`. Producing it in the existing handler keeps the round/`toolCallId` ordering guarantees.
4. `ClientSessionComponent` reads it via `useSessionFollowTarget`, gates on Follow mode, and folds it into `reviewOpen` and the `ReviewPanel` prop.
   - `reviewOpen` gains a disjunct from a new pure `shouldFollowOpen(target, followMode)`. The `sessionRunning` guard in `shouldOpenReview` **stays as-is** — `review-open.test.ts` asserts it, and this is a new explicitly-requested origin, not a relaxation.
5. `ReviewPanel` turns the target into a `FileSelection` and a reveal request; `ReviewEditorPane` → `ReviewEditor` → `code-editor.tsx`, whose existing effect calls `editor.revealLineNearTop(...)` / `editor.setPosition(...)`. **The last leg already exists.**

### 2.3 `initialTarget` → controlled target (the load-bearing change)

Replace `initialTarget` with `target?: FollowTarget | null`, consumed by nonce comparison **during render**, never in an effect:

- `chosen` becomes `useState<{ selection: FileSelection; nonce: number } | null>`; a manual click stamps a nonce from the panel's existing monotonic counter;
- `selection` is derived per render as whichever of `chosen` / `target` has the higher nonce, else `defaultSelection(review.data)`;
- `reveal` likewise: `max(localRevealNonce, target.nonce)` decides.

This satisfies `react/set-state-in-effect` (an **error** in `.oxlintrc.json`) with no remount, so drafts and expansion state survive a jump. `ClientSessionComponent` then drops the `key=` remount and routes `elementTarget.target` through the same prop — preserving its optional `precision` field so the `"component"` notice keeps working.

### 2.4 Follow mode: storage

- Canonical store: [`user-settings-store.ts`](src/lib/user-settings-store.ts) — add `followMode: boolean | null` to `UserSettings` and `EMPTY`; accept it in the `PUT` branch of `src/app/api/user-settings/route.ts`, which already merges independent field groups so one screen cannot erase another's field.
- Client: `useUpdateFollowMode` in `src/hooks/use-user-settings.ts`, mirroring `useUpdateSystemPrompt`'s optimistic `onMutate`/`onError`.
- Default ON: `null`/absent means on, encoded in one `followModeEnabled(settings)` helper so the default is not restated per read site.
- Not `localStorage`: the `sidebar.tsx` precedent needs an `oxlint-disable` for `react/set-state-in-effect` to restore before paint; the settings query has no such cost.
- UI: a third button in `session-topbar.tsx` beside the review-toggle and `onReviewLayoutChange`, via new `followMode` / `onFollowModeChange` props.

## 3. Line-number derivation

| Tool | Path | Line | Fallback | New server work? |
|---|---|---|---|---|
| `edit` | `params.path` | `details.firstChangedLine` — pi's `EditToolDetails` documents it as "for editor navigation" | line 1, then the editor's own hunk-based reveal usually corrects it | **Yes, two places** — see Phase 2 |
| `write` | `params.path` | none (whole-file write has no first change) | line 1 | No |
| `read` | `params.path` | `params.offset` (1-indexed; arrives stringified via `getParams`) | line 1 | No |
| `grep` | unreliable (`path` optional in pi's schema) | first match line parsed from `resultText` (`` `${relativePath}:${lineNumber}: …` ``, `-` for context lines) | **no target** — better than guessing a file | No, but needs a tested `firstGrepHit` parser |
| `bash` | — | — | no target; `session-project-attach.ts` already documents why `sed -i`/`mv`/`git` writes carry no typed path | No |
| everything else | — | — | no target | No |

**Path → `{ project, path }`:** a tool's `path` is absolute or cwd-relative, not project-relative. Reuse [`selectionForWorkspacePath`](src/components/review/review-definition-target.ts), which does segment-wise longest-prefix matching against `ProjectReview.path` (a string prefix is wrong: `semla` prefixes `semla-wiki`). A path in no linked project yields `null` — an ordinary outcome. Normalisation is the main unknown; see §5.1.

## 4. Phases

### Phase 1 — pure core, no UI
**Goal.** One tested function turning a `SessionToolCall` into a `FollowTarget`, shared by live and replay.
**Create.** `src/lib/review-follow-target.ts`, `src/lib/review-follow-target.test.ts`.
**Verify.** `npx vitest run src/lib/review-follow-target.test.ts` — `edit`/`write` mutating and `read`/`grep`/`bash` not, asserted *against* `writtenPath` so the definitions cannot drift; `read` with and without `offset`; a real-format grep string including a `-` context line; a path in no project yielding `null`. Then `npm run tsc` and `npm run lint`.

### Phase 2 — propagate `edit`'s `firstChangedLine` (server)
**Goal.** The one number that makes following an edit land on the change.
**Modify.** `src/lib/pi/session-events.ts` (optional `firstChangedLine?: number` on `tool-end`); `session-event-router.ts` `onToolEnd` (read `event.result?.details` behind a narrow type guard, beside the existing `readCodeMapResult` / `getBackgroundWorkflowRunId` precedent); `src/lib/pi/transcript.ts` `getToolCalls` (its `toolResultMap` must start carrying `details`); `src/hooks/use-session-messages.ts` (field on `SessionToolCall`); `src/lib/live-tool-calls.ts` (`LiveToolEvent` + fold, preserving its identity-on-no-change property).
Do **not** widen `SessionToolCall.params`, which is `Record<string, string>` by contract.
**Verify.** Extend `src/lib/live-tool-calls.test.ts` and the transcript tests: a result with `details.firstChangedLine` surfaces it, one without stays `undefined`. `npm run tsc`.
**Optional?** No — without it, following an edit lands on line 1.

### Phase 3 — `ReviewPanel` accepts a controlled target
**Modify.** `src/components/review/review-panel.tsx` (§2.3; keep `defaultSelection`, `revealLine`, `openWorkspacePath`, `selectFile`, `draftKey` intact); `client-session-component.tsx` (drop the `key=` remount, pass `elementTarget.target` through the new prop).
**Verify.** Observable: pick an element, type an unsaved edit, pick a second element — the panel jumps and the draft (and `ReviewCommitBar`'s unsaved count) survives, where today it is wiped. Plus `npm run lint` clean of `react/set-state-in-effect`.

### Phase 4 — live follow
**Modify.** `session-live-state.ts` (key + hook); `use-prompt-mutation.ts` (write the target in the tool handlers; clear it at the two `setLiveToolCalls([])` reset points, as is done for `sessionActiveToolKey`); `client-session-component.tsx` (read, gate, `shouldFollowOpen` disjunct, pass as `target`).
**Verify.** Observable: a turn that reads three files then edits one — panel stays shut through the reads, opens on the edit at the changed line; re-run with it already open and the reads navigate it. Unit-test `shouldFollowOpen`'s read/mutate asymmetry.
**Caution.** `closeReview` also calls `dismissReview.mutate(fingerprint)` so a refetch cannot reopen. A follow-opened panel the operator closes mid-turn must not reopen on the next edit, or the close button is useless. Record the closed nonce and require `target.nonce > closedAtNonce` — a boolean will not do, since a later edit is a genuinely new event.

### Phase 5 — Follow-mode toggle
**Modify.** `user-settings-store.ts`; `src/app/api/user-settings/route.ts` (`PUT`, `toRow`); `src/hooks/use-user-settings.ts`; `session-topbar.tsx`; `client-session-component.tsx`.
**Verify.** Extend `src/lib/user-settings-store.test.ts`: writing `followMode` does not erase `systemPrompt` (the merge property that module exists to guarantee), and a pre-existing record reads back default-ON. Observable: toggle off, reload, still off.

### Phase 6 — historical replay
**Modify.** `session-steps-strip.tsx` (`StepDetail` for `item.kind === "tool"` gains an "Open in review" affordance for calls yielding a non-null target, calling a new `onFollow(call)` prop); `src/components/session-conversation.tsx` (thread the callback); `client-session-component.tsx` (stamp `origin: "replay"` + fresh nonce into the cache).
**Verify.** Observable: after a finished turn, open the steps drawer, click a past `read` — the panel opens at that file and `offset`. A replay click is an explicit operator request, so it may open. Derivation is covered by Phase 1's tests.
Wiring `SessionWorkflowPanel`'s waterfall as a second entry point is optional.

### Phase 7 (optional) — decoration for the followed line
A transient highlight makes a jump legible when the file was already open. `src/components/review/review-decorations.ts` and its test are the existing home. Skip unless the jump proves hard to notice.

## 5. Risks & open questions

1. **Path normalisation is the real unknown.** `selectionForWorkspacePath` expects a workspace-relative path; `params.path` is whatever the model typed. The server has `projectOfPath`, `PI_WORKSPACE_ROOT` and the router's `agentCwd`; the client has none. Options: (a) resolve server-side in `session-event-router.ts` and emit an already-resolved `{ project, path }` — accurate, but adds an event field and does not help already-persisted calls; (b) resolve client-side and accept no target for paths outside a linked project. **Recommendation: (a) for live plus best-effort (b) for replay**, asymmetry documented. Decide before Phase 4; this is where the plan may change shape.
2. **`details` on persisted tool results is unverified end-to-end.** `ToolResultMessage<TDetails>` declares `details?: TDetails` and `edit` returns it, but whether `entry-persist-queue.ts` / `buildTranscript` stores the whole message or a trimmed projection was not confirmed. If not persisted, replay of an `edit` falls back to line 1 (recoverable — the hunk-based reveal usually lands correctly).
3. **Auto-open during a running turn contradicts a documented decision.** `review-open.ts`'s docblock argues a mid-turn panel "is describing a tree the agent is still writing to". The operator has overruled this for mutating tools; `shouldFollowOpen` must carry a docblock saying so, or a future reader will "fix" it back.
4. **Follow-jump churn.** Twenty reads in a row will yank an open panel twenty times. Cheap mitigation: ignore a target identical to the current selection and line, inside the pure function.
5. **`review-panel.tsx` is 503 lines** and gains behaviour here. Per `AGENTS.md`, extract the target/nonce derivation into a small pure module beside `review-file-display.ts` rather than growing the component.
6. **`SessionStepsStrip` only shows *silent* turns' tool calls** (`groupConversation` in `src/lib/session-steps.ts` folds text-less turns only). Phase 6 covers the folded-steps path; whether every historical tool call is clickable depends on the other rendering path, which was not located.
7. **Not verified:** whether any test asserts `ReviewPanel`'s `initialTarget`-on-mount contract or the `key=` remount. None was found; if one exists it needs updating in Phase 3.
