# Plan: keyboard-driven hunk review

**Goal:** after a turn that changed code, the operator moves through every
changed hunk with the keyboard — one at a time, in order, across files — and for
each one decides: stage it, revert it, skip it, or drop into line-level
selection and take part of it. When the last hunk is decided, focus lands in the
commit message input. This is `git add --patch` (the `gapa` alias), rendered in
the ReviewPanel.

**Status:** designed 2026-09-05, not started. Research was delegated and is
summarised in §1; signatures there are symbol-accurate but **not line-verified**
— confirm them before implementing. Two open questions in §7 need answers
before phase 2 or phase 4 begins.

---

## 1. What is actually true today

This feature is mostly a *cursor* and a *keymap* over machinery that already
exists. Two capabilities are genuinely new: reverting a hunk, and sub-hunk line
selection.

### Already built, reusable as-is

| Thing | Where | Note |
|---|---|---|
| Unified-diff parser | `src/lib/pi/review-diff.ts` — `parseUnifiedDiff` | hand-written; `@@` headers → `Hunk[]`, body → `DiffLine[]` tagged `added`/`removed`/`context` |
| Diff acquisition | `src/lib/pi/review-diff.ts` — `readFileDiff`, `readUntrackedDiff` | `git diff --no-color -U3 -M`, with `head` / `staged` / `index` modes |
| Character-level spans | `src/lib/pi/review-char-spans.ts` — `changedSpans` | already drives inline highlighting |
| Patch rebuild from a hunk subset | `src/lib/pi/review-patch.ts` — `buildPatch` | recomputes `newStart` so skipped hunks shift later ones correctly |
| Stage / unstage hunks | `src/lib/pi/review-apply.ts` — `stageHunks`, `unstageHunks` | `git apply --cached --unidiff-zero -` |
| Stage / unstage whole file | same — `stageWholeFile`, `unstageWholeFile` | `git add --`, `git restore --staged --` |
| Commit | same — `commitStaged` | checks index lock, unmerged paths, staged-emptiness; returns SHA |
| Changed-file read | `src/lib/pi/review-status.ts` — `readChangedFiles` | `git status --porcelain=v1 -z` |
| Hunk list UI | `src/components/review/review-hunk-list.tsx` | already groups "Not staged" / "Staged" with per-hunk buttons |
| Per-hunk gutter widgets | `src/components/review/review-hunk-bracket-widgets.tsx` | clickable brackets above each hunk in Monaco |
| Commit input + commit call | `src/components/review/review-commit-bar.tsx` | `<Input>`, Enter commits, → `POST /api/sessions/[id]/review/commit` |
| Panel open/close + Escape | `src/components/review/review-panel.tsx` | `shouldOpenReview({ manuallyOpened, review, sessionRunning })` |
| Turn-end signal | `src/lib/pi/session-service.ts` — `runPiPrompt` | `session.prompt()` then `agent.waitForIdle()` |
| Per-turn state on disk | `src/lib/pi/review-turn-mark.ts` — `ReviewTurnMark` | `SEMLA_STATE_DIR/review/<sessionId>.json`; `startedAt`, per-project `head`, dirty-set `fingerprint` |
| Review routes | `src/app/api/sessions/[id]/review/{hunks,stage,commit,uncommit,grep}/route.ts` | API routes, not server actions |

### The five gaps

1. **No revert.** Every write path in `review-apply.ts` targets the index
   (`--cached`) or `git add`. Nothing removes a change from the *working tree*.
2. **`buildPatch` is hunk-granular.** It selects whole hunks by index. Taking
   part of a hunk is not expressible in its current input.
3. **No keybinding infrastructure at all.** There is no `useHotkey`, no keymap
   context, no focus-trap utility, and no `j`/`k` navigation anywhere in the
   repository. What exists is four ad-hoc `useEffect` + `addEventListener`
   blocks: the sidebar's `Cmd+b` in `src/components/ui/sidebar.tsx`, Escape in
   `review-panel.tsx`, Escape in `src/components/element-picker.tsx`, and
   Enter/Backspace inside `src/components/ai-elements/input/prompt-input.tsx`.
4. **No UI in the ReviewPanel that shows which keyboard commands the user can
  press to navigate through the hunks and changed files.
5. **Review decisions are not persisted.** `ReviewTurnMark` persists the turn
   *boundary*, not what the operator decided about each hunk.

---

## 2. Decisions taken

Four questions were put to the operator on 2026-09-05 and answered.

**`split` means line-level selection, not `git add -p`'s `s`.** Git's `s`
subdivides a hunk at context-line boundaries and can refuse when the changed
lines are contiguous — a mechanism whose availability the operator cannot
predict from looking at the hunk. Line selection is always available and
strictly more expressive, at the cost of §4.

**`stage` is index-only.** `git apply --cached`; the working tree keeps the
change. This is what `stageHunks` already does.

**`revert` discards from the working tree, and is not undoable.** The operator
declined an in-session undo. This is a destructive key on a keyboard-driven
surface, so §3 puts a confirmation in front of it — the absence of undo is the
reason the confirmation is not optional.

**`skip` leaves the hunk alone** — unstaged, still in the working tree — and
advances the cursor.

**Review state is persisted, surviving reload.** See §5 for where, and why it
is not a Supabase table.

---

## 3. Phase 1 — reverting a hunk

New export in `src/lib/pi/review-apply.ts`, alongside `stageHunks`:

```
revertHunks(projectPath, path, hunks) → applies buildPatch output with
  git apply --reverse --unidiff-zero -   (no --cached: worktree, not index)
```

It reuses `buildPatch` unchanged. New route
`src/app/api/sessions/[id]/review/revert/route.ts`, mirroring the existing
`stage/route.ts` in shape and validation.

Two failure modes are specific to this path and must be handled rather than
collapsed into a generic error, because the operator has no undo:

- the hunk is **already staged** — a worktree reverse-apply then leaves the
  index and worktree disagreeing. Either refuse, or reverse out of both;
  refusing is the safer default and the one this plan takes.
- the file changed on disk since the diff was read, so the patch no longer
  applies. `git apply` fails cleanly here; the message must say so.

**Verification.** A test beside `src/lib/pi/review-apply.test.ts`, using the
same `execFileSync("git", …)` fixture-repo pattern: create a file with three
separated hunks, revert the middle one, assert `git diff` no longer contains it
*and* that the other two are untouched. Plus a test that reverting an
already-staged hunk is refused.

---

## 4. Phase 2 — line-granular patches

`buildPatch` takes whole-hunk selections today. Generalise its input to a per
hunk line selection — `{ hunkIndex, lineIndices }` — and derive the existing
whole-hunk behaviour as the case where every changed line is selected.

The transformation is where the risk lives, and it is asymmetric between the two
line kinds:

- an **unselected `added` line** is dropped from the patch entirely;
- an **unselected `removed` line** becomes a **context** line — it must stay in
  the patch body with a leading space, because the file still contains it;
- `context` lines are always kept;
- both counts in `@@ -a,b +c,d @@` must be recomputed from the resulting body,
  and `newStart` offsets of *later* hunks shift by the net line delta — the same
  correction `buildPatch` already applies for skipped hunks, now driven by a
  per-line count.

Once `buildPatch` accepts line selections, `stageHunks` and the new
`revertHunks` inherit sub-hunk capability without further change.

**Verification.** This phase is verifiable cheaply and thoroughly, which is the
argument for doing it properly rather than carefully:

- table-driven unit tests asserting **exact patch text** for: all lines
  selected, no lines selected, only additions, only deletions, an
  addition/deletion pair split down the middle, and a selection in hunk 2 of 3
  (to pin the offset correction);
- round-trip tests that `git apply --cached` and `git apply --reverse` both
  *accept* every generated patch against a fixture repo, then that the resulting
  `git diff`/`git diff --cached` is what the selection implies. A patch that
  parses but that git rejects is the failure this catches.

---

## 5. Phase 3 — the cursor, and persisting decisions

A `useReviewCursor` hook owning a **flat, ordered sequence** of
`(project, file, hunkId)` derived from the changed-file data the panel already
fetches, plus a decision per entry:

```
pending | staged | reverted | skipped | partial
```

`advance()` moves to the next `pending` entry, rolling from the last hunk of one
file into the first hunk of the next; when none remain it emits a
`reachedEnd` signal, which is what phase 4 turns into focus on the commit input.

**Hunks are identified by a content hash, not by index.** Index identity breaks
the moment anything is staged or reverted, because that rewrites the diff and
renumbers every later hunk — which is exactly what this surface does on every
keypress. A hash over the hunk body is stable across the re-fetch.

**Persistence goes in `ReviewTurnMark`, not a new Supabase table.** That file at
`SEMLA_STATE_DIR/review/<sessionId>.json` already exists, is already per
session, and is already written at turn start. It matches the repository's
established "disk is authoritative, Postgres is a mirror" convention — the same
one recorded in `20260901000000_add_session_projects.sql`. A migration would buy
nothing here: this state is worthless without the working tree it describes, and
the working tree is not in Postgres. Extend the mark with a
`decisions: Record<hunkHash, Decision>` map.

A decision whose hunk hash no longer appears in the current diff is dropped on
read, not treated as an error: it means the hunk was staged, reverted, or
overwritten, and the diff is the truth.

**Verification.** The cursor is a reducer over plain data, so it is unit-testable
with no DOM: ordering across files, `advance()` skipping already-decided hunks,
roll-over between files, `reachedEnd` firing exactly once. The mark extension
gets read/write tests including the stale-hash-dropped case.

---

## 6. Phase 4 — keybindings

The repository has no keymap layer (§1, gap 3). This plan adds one small scoped
`useKeyMap` hook rather than a fifth ad-hoc `window` listener — four is already
the point at which precedence between them is undefined, and this feature adds
around eight bindings that must not fire while a text input has focus.

Proposed bindings, following `git add -p` where it has an established letter:

| Key | Action |
|---|---|
| `j` / `k` (and `n` / `p`) | next / previous hunk |
| `s` | stage the hunk |
| `r` | revert the hunk — **confirm**, per §2 |
| `space` | skip |
| `v` | enter line-selection mode |
| `Escape` | leave line-selection, else close the panel (existing behaviour) |

Focus moves into the commit input on `reachedEnd` using the pattern already in
the codebase — `setTimeout(() => ref.current?.select(), 0)`, as in
`src/components/goal-editor.tsx` and `src/components/session-item.tsx`.

**This phase is the biggest unknown in the plan, and it is a focus problem, not
a keymap problem.** Monaco installs its own keyboard handling and swallows
single-letter keys whenever the editor has focus — and the ReviewPanel's centre
is a Monaco editor. So either the cursor keys live on a container element that
Monaco never holds focus within, or they are registered as Monaco commands via
`addCommand`/`addAction` and therefore need registering *twice*, once for each
focus context, with the two kept in agreement. §7 asks which.

**Verification.** Honestly: this is the one phase whose acceptance is manual. A
unit test can assert that `useKeyMap` dispatches the right action for a
synthesised `keydown`, and should — but that a keypress reaches the hook at all
while Monaco is mounted is a browser-level fact. A Playwright check on the real
panel is the only thing that proves it; if that is out of scope, this phase
needs an explicit manual acceptance pass and the plan should say so rather than
imply coverage.

---

## 7. Phase 5 - add UI to ReviewPanel

The user was to have a pill shaped bar that floats above the Commit bar, over 
the Monaco editor and its sidebar.  It should show the keyboard command the user
can use to perform actions to the hunks. It should also have buttons with a left 
and a right arrow on the outer sides of the bar that allow the user to jump
to the next hunk, or when at the last hunk in a file, the next file.  

---

## 8. Open questions

**Q1 — Is line-selection in the first cut?** Phases 1, 3 and 4 deliver a working
keyboard hunk-review loop on their own. Phase 2 is the larger half of the
server-side work and carries the correctness risk described in §4. Shipping
1/3/4 first and adding phase 2 behind the `v` key afterwards is a clean seam,
because the `buildPatch` generalisation is backward-compatible by construction.

**Q2 — Where does the hunk cursor listen?** Driving it from the sidebar hunk
list avoids the Monaco focus conflict entirely and is implementable today.
Driving it from inside the editor is the better surface — the operator's eyes are
on the diff, not the sidebar — but requires the dual registration in §6.

Both are answered before the phase that depends on them, not before phase 1.

---

## 8. Order of work

1. Phase 1 (revert) — self-contained, fully unit-testable.
2. Phase 3 (cursor + persistence) — pure logic, no UI dependency.
3. Phase 4 (keymap + wiring) — needs Q2 answered.
4. Phase 2 (line selection) — needs Q1 answered; may be deferred.

Every phase changes code, so per this repository's rules each lands with a
review subagent pass, and `npm run tsc`, `npm run lint` and `npm test` green
against the tree as it stands — no `git stash`.
