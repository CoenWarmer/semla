# Plan: a review surface for what a turn changed

**Goal:** after a turn that changed code, present the operator with a review
surface — the repository's file tree in a sidebar, a bucket of changed files
above it, and a Monaco editor to the right showing the working file with the
changed lines and characters coloured in place. The operator reads, edits if
they want to, stages the hunks they accept, and commits. The commit is the
operator's, not the agent's.

**Status:** built 2026-09-03, phases 0–7 complete. Three questions were put to
the user and answered; each is recorded in §3 with the reasoning, not just the
verdict. What the build changed about the plan is in §13 — read that before
trusting §5 or §6, which describe the intent rather than the result.

---

## 1. What is actually true today

Most of the read side already exists. This is worth establishing precisely,
because it changes what the work is: this feature is mostly a *write* path and
a *hunk model*, not a file browser.

### Already built, reusable as-is

| Thing | Where | Note |
|---|---|---|
| File tree UI | `src/components/session-file-tree.tsx` | `SessionFileTree`, `useSessionFiles`, query keys per directory |
| Directory listing route | `src/app/api/sessions/[id]/files/route.ts` | |
| File read route | `src/app/api/sessions/[id]/files/content/route.ts` | `GET` only |
| Path containment | `src/lib/pi/file-browser.ts:45,67` | `resolveFileRoot`, `resolveInsideRoot` |
| Project allowlist | `src/lib/pi/session-project.ts:27,54` | `sessionProjects`, `projectAbsolutePath` |
| Git subprocess | `src/lib/pi/git.ts:37,68` | `git` (collapses to null), `gitResult` (keeps stderr) |
| Human-readable git failure | `src/lib/pi/git-actions.ts:27` | `explainGitFailure` |
| Branch/divergence read | `src/lib/pi/git-status.ts:111` | `readGitStatus` |
| Turn-end client hook | `src/hooks/use-prompt-mutation.ts:568` | `onSettled`, plus the `complete` SSE event at `src/lib/pi/session-events.ts:48` |
| Panel/portal precedent | `src/components/bottom-panel.tsx` | the frame owns chrome, the session owns data |

### The three gaps

1. **No write path.** The content route is `GET` only. Nothing in the app can
   write a file. Operator edits need one.
2. **No diff or hunk model anywhere.** Nothing shells out to `git diff` or
   parses porcelain status. `GitStatus`
   (`src/lib/git-status-display.ts:9`) is branch, head, base, ahead, behind —
   it says a working copy diverged, never *what* changed in it.
3. **No editor.** No Monaco, no CodeMirror, nothing. `grep -rln monaco src
   package.json` is empty. Monaco is a new dependency.

### The change-detection trap

`src/lib/pi/session-project-attach.ts` already observes writes per turn, and
`session-event-router.ts:171,199` calls it on every `tool-end`. It looks like
the natural trigger. It is not sufficient, and its own docblock says why:

> Writes made through `bash` — `git commit`, `sed -i`, `mv`, generated build
> output — carry no typed path and are **not** detected. That is a known gap.

The agent has `bash` (`src/lib/pi/runtime-config.ts:149`). A turn that fixes a
file with `sed -i` or regenerates a lockfile changes code and produces no
`writtenPath`. Building the trigger on tool observation inherits that gap and
would show the operator an empty review panel after a turn that changed twelve
files.

**So the source of truth is `git status --porcelain`, run against the session's
projects.** It sees every change however it was made. Tool observation stays
what it is — the project-attachment signal — and is at most a cheap hint that a
porcelain read is worth doing.

---

## 2. The model

Two kinds of thing need reviewing, and they are not the same shape.

- **Working-tree changes.** Uncommitted modifications, additions, deletions,
  renames, and untracked files. The primary case.
- **Turn commits.** Commits the agent made during the turn. Nothing stops it:
  the system prompt (`src/lib/pi/system-prompt.ts:12`) has no policy on git at
  all, and `bash` is in the tool set. Today those changes are simply invisible
  to any reviewer.

The unit of review is the **hunk**, not the file. That follows from the staging
decision in §3.2 and from this repository's own commit rule ("if one file
contains unrelated changes, split them by hunk"). One `git diff` parse serves
both purposes: it drives the editor's decorations *and* it is what gets
selectively applied on commit. There is one hunk model, not two.

```
ReviewState (per project)
  changedFiles: ChangedFile[]        from git status --porcelain -z
  turnCommits:  TurnCommit[]         from git log <startSha>..HEAD
  startSha:     string | null        HEAD when the turn began
  hunks:        per file, from git diff -U3 --no-color
```

---

## 3. Decisions

### 3.1 Agent commits are reviewed too, not forbidden

**Decision.** The agent stays free to commit. The panel additionally lists
commits made during the turn and offers to bring them back into the working
tree for review.

**Why.** The alternative — a "never commit" line in `DEFAULT_SYSTEM_PROMPT` —
is one sentence of work and would have made this feature smaller. It was
rejected because it constrains every session to serve one panel, and because a
prompt rule is a request, not a guarantee: a model that commits anyway produces
exactly the silent gap the rule was meant to close, with nothing in the UI
saying so. Reading `git log` is a fact about the repository and cannot be
disobeyed.

**Consequence.** A soft reset is now in scope, and it is the only genuinely
destructive operation in the feature. §7 is about nothing else.

### 3.2 Hunk-level staging

**Decision.** A real staging surface: stage and unstage individual hunks, then
commit what is staged.

**Why.** It is what the repository's own commit convention asks for, and a
per-file checkbox cannot express "these three lines belong with this commit and
those two do not" — which is the common case when a turn touches a file for two
reasons.

**Consequence.** This is the hardest part of the build and the one most likely
to be subtly wrong. §6 is its own section, and it carries the heaviest tests.

### 3.3 One editor with decorations, not a two-pane diff

**Decision.** A single Monaco editor holding the working-tree file, with the
changed lines and the changed characters within them coloured by decoration.
Editable in place. No `DiffEditor`.

**Why (user's own reasoning).** "Monaco can be configured to color code lines
and characters." A two-pane diff halves the width available to read code in,
and it makes editing the odd case — the right pane of a diff is a strange
place to type. Decorations keep one full-width editor that happens to know what
changed, so reading and editing are the same act.

**Consequence.** Character-level diff detail is now required, not optional
polish, and it has to survive the operator typing (§5).

---

## 4. Layout and mounting

```
                    ┌─ 40px top ─┐
  ┌20px┐  ┌──────────────────────────────────────────┐  ┌20px┐
         │ Review · semla · 4 files, 2 commits    ✕ │
         ├──────────────────┬───────────────────────┤
         │ CHANGED (4)      │                       │
         │  ● git.ts     +12│   Monaco               │
         │  ● git.test.ts +40│   working tree,        │
         │  ● badge.tsx   -3│   changed lines and     │
         │  ○ AGENTS.md   ~1│   characters coloured   │
         │                  │                       │
         │ COMMITS (2)      │   ┌─ hunk 1 ─ [stage] │
         │  ⤺ [Git]: parse  │   │                    │
         │                  │                       │
         │ ── tree ──────── │                       │
         │  ▸ src/          │                       │
         │  ▸ docs/         │                       │
         ├──────────────────┴───────────────────────┤
         │ staged: 3 hunks   [Component]: ______  ( Commit ) │
         └──────────────────────────────────────────┘
                    └─ above the console bar ─┘
```

**Offsets.** `left: 20px`, `right: 20px`, `top: 40px` as specified. The bottom
was not specified and is a judgement call: the overlay stops above the console
bar rather than covering it. `AppConsole` is rendered in the root layout
outside `{children}` (`src/app/layout.tsx:72`) precisely so it stays put, and
it hosts the agent timeline and terminal — covering it would hide controls
while the operator is reviewing the output of the run those controls describe.
`BAR_HEIGHT` is `h-6` (`src/components/app-console.tsx:35`), so `bottom: 24px`
when collapsed. Read it from the bottom-panel context rather than hard-coding,
so an expanded panel does not end up underneath the overlay.

**Mounting.** Rendered by the session tree, `position: fixed`. Fixed
positioning already escapes the flow, so no portal is needed — unlike the
bottom panel, which had to portal because the *bar* lives in the frame. The
data (which files this turn changed) belongs to the session subscription, which
is the same reasoning `bottom-panel.tsx`'s docblock sets out.

Note the session column is `px-20 py-4`
(`src/components/client-session-component.tsx:415`); the overlay is not inside
that padding and must not inherit it.

---

## 5. The editor

**Dependencies.** `monaco-editor` plus `@monaco-editor/react@4.7.0`, whose peer
range is `react ^16 || ^17 || ^18 || ^19` — React 19.2 is satisfied. Both go in
the root `package.json`, pinned exactly, per AGENTS.md.

**Client-only.** `dynamic(() => import(...), { ssr: false })`. Monaco touches
`window` at module scope.

**Self-host the assets.** `@monaco-editor/react` defaults to fetching Monaco
from a CDN. Point `loader.config({ monaco })` at the local package instead.
This repository already refuses to depend on the network at boot — the model
catalog refresh is best-effort and skipped under `PI_OFFLINE`
(README, "Isolation from the host") — and a review panel that cannot render
without internet is worse than one that costs a bundle.

**Workers are the integration risk.** Monaco ships its language services as web
workers and needs `MonacoEnvironment.getWorkerUrl` wired to URLs the bundler
actually emits. Turbopack resolves worker imports differently from webpack, and
this is the single thing in the plan I cannot predict from reading code. Hence
the spike in §9, phase 0. Loading only the `editorWorker` and skipping the
TypeScript language worker is an acceptable fallback: syntax colouring and
decorations do not need it, and code intelligence in this app comes from supi
and the code map, not from Monaco.

**Bundle.** Monaco is several megabytes. It must be reachable only through the
dynamic import, so a session that never opens the panel never downloads it.
Confirm with `next build` output that it lands in its own chunk.

**Theme.** Monaco does not read CSS variables; a theme has to be registered
with literal colours via `monaco.editor.defineTheme`. This is the same class of
problem as the shimmer's pinned theme — the app's colours have to be restated
for a component that cannot see them. Derive one theme from the app's palette
and register it once.

### Decorations

Line-level from the parsed hunks; character-level from a word diff within each
changed line pair. Two candidate sources for the character detail:

- `git diff --word-diff=porcelain --word-diff-regex=.` server-side, which keeps
  all diff computation in one place and one language; or
- a client-side diff of the two line strings.

Prefer the server: the hunks are already being parsed there for staging, and
one authority for "what changed" is worth more than saving a subprocess.

**Surviving edits.** Monaco decorations are model-anchored ranges and shift
correctly as the operator types, so they degrade gracefully rather than
scattering. They do go stale in meaning — a line the operator has rewritten is
no longer the line the agent wrote. Recompute on save (debounced), and treat
the coloured state as "as of the last read", which is honest and cheap.

---

## 6. Server side

### New modules

`src/lib/pi/review-status.ts`
- `readChangedFiles(projectPath)` → `ChangedFile[]`, from
  `git status --porcelain=v1 -z --untracked-files=all`. `-z` because paths with
  spaces or non-ASCII are otherwise quoted and escaped, and every hand-rolled
  unquoter gets it wrong eventually.
- `readTurnCommits(projectPath, startSha)` → `TurnCommit[]` from
  `git log --format=... <startSha>..HEAD`.

`src/lib/pi/review-hunks.ts`
- `readHunks(projectPath, relPath)` → `Hunk[]`, from `git diff -U3 --no-color
  -- <path>` (and `--cached` for what is already staged).
- `buildPatch(file, hunks)` → a unified diff containing only the selected
  hunks, with headers and line offsets recomputed.

`src/lib/pi/review-apply.ts`
- `stageHunks(projectPath, patch)` → `git apply --cached --unidiff-zero -`
- `unstageHunks(projectPath, patch)` → the same with `--reverse`
- `commitStaged(projectPath, message)` → `git commit -m` (no `-a`)

`src/lib/review-types.ts` — `ChangedFile`, `Hunk`, `TurnCommit`, and the status
enum. **Node-free**, mirroring the `git-status-display.ts` / `git-status.ts`
split. `client-boundary.test.ts` walks the whole import graph and a client
component reaching a module that imports `node:fs` breaks the entire page
compile with an unrelated-looking ENOENT — its docblock is worth reading before
placing these types.

### New routes

All under the session, all deriving the repository from
`sessionProjects(id)` rather than accepting it:

| Route | Does |
|---|---|
| `GET  /api/sessions/[id]/review` | changed files + turn commits per project, keyed by workspace-relative path, anchor first |
| `GET  /api/sessions/[id]/review/hunks?project=&path=` | hunks for one file, staged and unstaged |
| `PUT  /api/sessions/[id]/files/content` | write a file — extends the existing route |
| `POST /api/sessions/[id]/review/stage` | stage or unstage selected hunks |
| `POST /api/sessions/[id]/review/commit` | commit what is staged |
| `POST /api/sessions/[id]/review/uncommit` | soft-reset turn commits back into the tree (§7) |

**The allowlist convention is not optional here.** The docblock on
`src/app/api/sessions/[id]/git/route.ts` (POST) sets out the rule this feature
must follow: the supplied path is checked against the projects *this session* is
linked to, the absolute path is derived from the matched link, and refs are
re-resolved server-side, "so neither the repository nor the ref is ever the
caller's to choose." Every route above takes a project *identifier*, matches it
against the links, and derives the path. Every file path additionally goes
through `resolveInsideRoot`.

Semla is single-user and loopback-bound, so this is not defence against a
remote attacker; it is defence against a bug in the panel pointing a commit or
a reset at the wrong repository.

### Sharp edges in the git plumbing

- **Untracked files have no diff.** `git diff` says nothing about them, so
  there are no hunks to stage. Either add whole (`git add -- <path>`) or run
  `git add -N` first to get intent-to-add and a diff against empty. Pick
  intent-to-add so untracked files behave like every other row.
- **`--unidiff-zero`** is needed if hunks are ever generated at `-U0`; with
  `-U3` context it is not, but the flag is harmless and the failure mode
  without it (silently rejected patch) is bad.
- **`\ No newline at end of file`** must be preserved verbatim in a generated
  patch or `git apply` rejects it.
- **Renames** arrive as `R old -> new` in porcelain and as a rename header in
  the diff. Stage as a unit; do not try to hunk-split the rename itself.
- **Mode changes** with no content change produce a diff with no hunks. Row
  must still appear and still be stageable.
- **CRLF** — generate patches from the bytes git reports, never from
  re-encoded editor content.
- **Timeouts.** `gitResult`'s default is 10s; a diff of a very large file
  deserves more, and `git status` on a kibana-sized tree can exceed the 2s
  default on `git`.

---

## 7. Turn commits and the soft reset

This is the only destructive operation in the feature and needs to be treated
as such.

**Capture.** Record HEAD per project when a prompt starts, alongside the
existing turn bookkeeping. Without a start sha there is no range and the panel
shows no commits — which is the correct behaviour for a session resumed after a
restart, not something to guess around.

**Display.** `git log <startSha>..HEAD` — sha, subject, author, file count.
Read-only, and useful on its own: it tells the operator the agent committed,
which nothing does today.

**Bringing them back.** `git reset --mixed <startSha>` puts the commits' changes
into the working tree as unstaged edits, which is exactly the state the rest of
the panel is built for. `--soft` would leave them staged and pre-empt the
staging decision, so `--mixed` it is. The commit messages are shown and offered
as the starting text for the new message, because throwing away a written
message to retype it is a bad trade.

**Guards. All of these refuse rather than proceed:**

- `startSha` must be an ancestor of `HEAD` (`git merge-base --is-ancestor`).
  Never reset to an unrelated sha.
- Nothing in `<startSha>..HEAD` may be contained in `@{upstream}`. Resetting a
  pushed commit rewrites shared history; per the repository's own git rules that
  needs explicit authorisation, and the panel is not the place to ask for it.
- The working tree must be clean of *other* changes, or the operator must
  confirm, since the reset mixes agent commits into edits already in progress.
- Refuse on detached HEAD, mid-merge, mid-rebase, or with a `.git/index.lock`
  present.
- Requires explicit confirmation naming the commit count and the target sha.
  Never a one-click action beside a benign one.

The reset is recoverable through the reflog, and the confirmation should say so
— it makes the action honest rather than frightening.

---

## 8. When it appears

The requirement is "automatically after a turn is done that has led to code
changes". Three things have to be true: the turn ended, something changed, and
the change came from *this* turn.

**Mechanism.** On turn end — `onSettled` in `use-prompt-mutation.ts:568`, with
the `complete` SSE event as the earlier signal — fetch
`/api/sessions/[id]/review`. If any project reports changed files or turn
commits, open the overlay.

**Why client-side rather than a new SSE event.** A `PiSessionEvent` variant was
considered and rejected: the client already knows the turn ended, so the event
would carry no information the client lacks, and every variant added to
`session-events.ts` is another shape the router, the persist queue and the
recovery path have to agree on. One fetch is simpler and cannot desynchronise.

**Attribution to the turn.** Take a porcelain snapshot and HEAD at turn *start*
as well, and compare. Changes that predate the turn — a dirty tree from
yesterday — do not pop a panel open, but they are still listed once it is open,
because a commit would include them and hiding them would be a lie.

**Suppression rules**, so it does not become an annoyance:

- Never while a turn is running.
- Not again for a state the operator already dismissed: remember the last
  reviewed (HEAD, dirty-set) fingerprint per session.
- Manual open is always available from the session topbar, so a dismissal is
  never a dead end.
- A cap on the changed-file list with "show more". A turn that regenerates a
  lockfile or touches 400 files in kibana must not try to read 400 diffs.

---

## 9. Phases

**Phase 0 — Monaco spike.** One client component, self-hosted Monaco, dark
theme, a hard-coded file, and two decorations. Gate: it renders, it edits,
workers resolve, and `next build` puts it in its own chunk. This is first
because it is the only unknown; everything else is code whose shape is already
determined by what is in the repository.

**Phase 1 — Read side.** `review-status.ts`, `review-hunks.ts`,
`review-types.ts`, `GET /review`, `GET /review/hunks`, with tests. No UI.

**Phase 2 — Overlay shell.** Fixed div at the specified offsets, changed-files
bucket, `SessionFileTree` below it, project switcher, editor pane wired to the
existing content route. Manual open only.

**Phase 3 — Decorations.** Line and character colouring from the hunks;
recompute on save.

**Phase 4 — Editing.** `PUT` content with containment, dirty-state tracking,
unsaved-changes guard on close.

**Phase 5 — Staging and commit.** `buildPatch`, stage/unstage, the commit
route, message field, failures surfaced through `explainGitFailure`.

**Phase 6 — Turn commits.** Start-sha capture, commit list, the guarded reset.

**Phase 7 — Auto-appear.** Snapshot comparison, open rules, dismissal
fingerprint, topbar entry point.

**Phase 8 — Polish.** Esc to close, file-to-file keys, hunk navigation, empty
and error states, the file cap.

Phases 1–2 are independently useful: "show me what this turn changed" has value
before anything can be committed from it.

---

## 10. Risks

| Risk | Mitigation |
|---|---|
| Monaco workers under Turbopack | Phase 0 spike; editor-worker-only fallback |
| Patch generation subtly wrong — stages the wrong lines | Heaviest test file in the feature; round-trip property test (stage then unstage returns the original tree) |
| Bundle size | Dynamic import only; verify the chunk in build output |
| Soft reset destroys work | §7 guards; explicit confirmation; reflog stated in the UI |
| React Compiler violations | `reactCompiler` is on and oxlint errors on `react(refs)` and `react(set-state-in-effect)`. Monaco wrappers habitually read `editorRef.current` during render, which is exactly the `react(refs)` error. Keep the instance in a ref touched only from handlers and effects. The existing 18 lint errors are all in vendored `ai-elements`; this feature adds none. |
| Very large repositories | File cap, lazy per-file hunk reads, raised git timeouts |
| Concurrency: agent writes while the operator edits | Panel is for finished turns and does not open during a run; on save, compare against the content read and refuse a blind overwrite |

---

## 11. Tests

Colocated `.test.ts` per module, as everywhere else in `src/lib/pi`.

- `review-status.test.ts` — porcelain `-z` parsing: renames, copies, untracked,
  deletions, staged-and-modified (`MM`), paths with spaces and non-ASCII,
  unmerged entries.
- `review-hunks.test.ts` — diff parsing: multiple hunks, no-newline-at-EOF,
  mode-change-only, binary files, empty diff.
- `review-patch.test.ts` — the load-bearing one. Patch generation for a subset
  of hunks, offsets recomputed; round-trip stage/unstage restores the tree;
  a generated patch is accepted by real `git apply --check` in a temp repo.
- `review-reset.test.ts` — every guard in §7 refuses: non-ancestor sha, pushed
  commits, detached HEAD, mid-merge, lock present.
- `review-trigger.test.ts` — start/end snapshot comparison; pre-existing dirt
  does not open the panel but is listed; dismissal fingerprint suppresses
  reopening; never opens while running.
- `review-routes.test.ts` — a project not linked to the session is rejected; a
  path outside the project root is rejected; `PUT` refuses a blind overwrite.
- `client-boundary.test.ts` — extended so `review-types.ts` stays node-free.

---

## 12. Deferred

Not in this plan, deliberately:

- **Comments on lines.** A review surface invites annotation, and annotation
  invites a thread model and somewhere to store it. Out of scope until the
  panel is used.
- **Sending a review back to the agent** ("fix these three things"). Natural
  next step, and cheap once hunks are addressable — but it is a second feature
  and would blur what "approve" means.
- **Push.** Approve commits. It does not push.
- **Multi-user review.** Semla is single-user; this inherits that.
- **Branch creation on approve.** Committing onto the current branch is what
  was asked for. Branch policy is `git-actions.ts`'s territory.

---

## 13. What the build changed

Seven things came out differently. Each is here because the plan is wrong
without it, not as a changelog.

**Monaco runs with no web workers at all.** §5 said to bundle them locally.
That does not survive the toolchain: Turbopack resolves
`new Worker(new URL("./x.ts", import.meta.url))` as a static *asset* reference
and emits the TypeScript file verbatim into `.next/static/media`, so the
browser fetches a `.ts` and fails. Monaco's own default fetches from a CDN,
which this application will not depend on to render itself. Nothing here needs
one — workers serve diagnostics, completion, formatting and `DiffEditor`'s diff
computation, and this panel colours from hunks git already produced. Every
feature that would reach for one is switched off explicitly (`links`,
`colorDecorators`, `wordBasedSuggestions`, and the JSON mode reduced to
`tokens: true`), and `getWorker` throws a message naming the reason. The spike
in phase 0 is what found this, which is what it was for.

**Character spans are computed in TypeScript, not by `git diff --word-diff`.**
§5 preferred the server for having one authority. A pure function over two
strings *is* server-side, and it is exhaustively testable without a
subprocess — where the word-diff route needs its porcelain output mapped back
to column offsets, which is the part that goes wrong. `review-char-spans.ts`
does a common prefix/suffix trim and then a token-level LCS over what is left,
bounded at 400 tokens so a pair of minified lines degrades to one coarse span
rather than churning.

**`gitRaw` had to be added to `git.ts`.** Both existing helpers trim their
output, which silently corrupts `git status --porcelain`: its first column is a
space when the index is clean, so `" D gone.txt"` arrives as `"D gone.txt"`,
every field shifts by one, and the first entry is reported with a truncated
path and its two status codes inverted. The parser tests could not see this —
they never went through the helper — and it surfaced only against a real
repository. `review-git-integration.test.ts` exists for that class of bug.

**`gitInput` had to be added too.** `git apply` reads its patch from stdin and
`execFile` cannot supply one. Writing the patch to a temp file would have reused
`gitResult` unchanged and was rejected: a patch is the exact content of the
operator's staging decision, and putting it on disk means a crash leaves it
there.

**Untracked files are diffed with `--no-index` against /dev/null.** §6 proposed
`git add -N`. That writes to the index during what the operator asked to be a
read, and a panel that mutates the repository to render itself is the wrong
shape. `--no-index` produces the same `new file mode` diff with no side
effects. It implies `--exit-code`, so stdout has to be read even when git exits
non-zero.

**Hunks are presented in two groups, staged and not, rather than one list with
checkboxes.** The underlying diffs really are two — staging selects from the
worktree against the index, unstaging from the index against HEAD — and their
hunks are numbered independently. A single spanning list would have a checkbox
that meant different things depending on the row.

**`git commit --only` is not used.** §3.2's sketch mentioned it. The panel
stages explicitly, hunk by hunk, and `--only -- paths` re-stages whole files,
which would quietly discard the operator's selection.

### Still open

- Removed lines are a wedge in the glyph margin with the count on hover, not
  rendered inline. Showing the departed content in place needs Monaco view
  zones; the marker is honest but terse.
- No file-to-file keyboard navigation. Escape closes and Cmd-S saves.
- The changed-file cap (`CHANGED_FILE_CAP`, 200) reports how many it omitted
  but offers no way to see them.
- Nothing has driven the panel in a browser. The routes are verified end to end
  against a live server — including a hunk staged and unstaged through the HTTP
  route, restoring the tree exactly — but that Monaco paints, and that the
  decorations land where `review-decorations.test.ts` says they should, is
  inferred from the build rather than observed.
