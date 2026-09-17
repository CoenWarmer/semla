# Plan: commit-scoped changed files in the review panel

**Goal:** let the operator see, per commit, exactly which files that commit
changed — instead of one undifferentiated list mixing committed, staged and
unstaged work.

**Status:** specified 2026-xx, implementing in the same session as this doc.

---

## 1. What is true today

`ReviewCommitNav` (src/components/review/review-commit-nav.tsx) already renders one dot
per `TurnCommit` and already has a `selectedSha`. Selecting a dot does exactly
one thing, at src/components/review/review-panel.tsx:445:

```ts
const visibleFiles = selectedCommit
  ? (activeProject?.changedFiles ?? []).filter((f) =>
      selectedCommit.files.includes(f.path),
    )
  : (activeProject?.changedFiles ?? []);
```

That is an **intersection of the commit with the working tree**, which is the
wrong set in the common case. A file the agent committed and did not touch
again is clean, so `git status` does not report it, so it is not in
`changedFiles` — and selecting the commit that changed it shows nothing. The
list the operator gets is "files this commit touched *and* which are still
dirty", which is not a question anybody asks.

Everything below the label is also still working-tree shaped: `ReviewStagedFiles`
lists what the index holds, the "To review" rows filter on `unstaged || !staged`,
and folding a row open calls `useReviewHunks` → `/api/sessions/[id]/review/hunks`,
which diffs the working tree (`HEAD`, `--cached`, index) and 404s any path
`git status` does not report. There is no way to ask the server what a *commit*
changed in a file.

`TurnCommit.files` is read with `git log --name-only` (review-status.ts:~205), so
it carries paths but no per-file status and no rename pre-image.

## 2. What this feature is

**One selector, four behaviours.**

1. **A commit dot selected** → the file list is that commit's files, taken from
   the commit, not from the working tree. Nothing unstaged or uncommitted is
   shown. Rows fold open to the **commit's own diff**, read-only — there is
   nothing to stage in a commit.
2. **A trailing dot** at the end of the nav means "the working tree": only
   uncommitted and unstaged changes. This is the **default** selection — it is
   the same state as today's `selectedSha === null`, so no new state is
   introduced, only a dot that makes the existing default visible and
   clickable.
3. The label reads **"Changed files in `eafa5`"** when a commit is selected,
   with the short sha in mono, in place of "Changed files in <project>".
4. That label carries a **close button** while a commit is selected; pressing it
   clears the selection back to the working-tree dot.

**Deliberately out of scope.** The editor pane keeps showing the working-tree
file. A commit's pre-image is a different blob, and showing commit hunks over
current file content would mis-place them for any file edited since. The fold-open
hunk list is the surface that changes; the editor is not.

## 3. Design

### 3.1 Server: a commit is diffable

`review-diff.ts` gains one reader:

```ts
export async function readCommitFileDiff(
  projectPath: string, sha: string, relPath: string,
): Promise<FileDiff | null>
```

`git show --no-color -U3 -M --format= <sha> -- <path>`. `git show` rather than
`diff <sha>^..<sha>` because the root commit has no `^` and the range form fails
there; `--format=` suppresses the commit header so the output is a plain unified
diff `parseUnifiedDiff` already handles.

`sha` is never interpolated into a shell — `gitResult` takes an argv array.
It is validated as a 40-hex sha *and* required to be one of the session's own
`turnCommits`, so the route cannot be used to read arbitrary history.

### 3.2 Server: a commit knows its files' statuses

`readTurnCommits` switches `--name-only` to `--name-status`. `TurnCommit` gains:

```ts
/** Per-file status within the commit; same order as `files`. */
fileChanges: CommitFileChange[];  // { path, oldPath, status: ChangeStatus }
```

`files: string[]` **stays**, unchanged and still the new-side paths, because
`artifact-capture.ts:216` slices it and `artifact-types.ts` stores it.

### 3.3 Route: `GET /review/hunks?...&sha=<sha>`

With `sha` present the route skips `readChangedFiles` entirely and answers from
the commit:

```
{ full: <commit diff>, staged: null, unstaged: null, untracked: false,
  file: <ChangedFile synthesized from the commit's fileChanges>, project, commitSha }
```

`staged`/`unstaged` null is the load-bearing part: it is what tells the client
there is nothing to stage, rather than the client inferring it from a flag it
could get wrong. A commit that does not contain the path, or a sha not in this
session's turn commits, is a 404 and a 400 respectively.

### 3.4 Client

- `useReviewHunks(sessionId, project, path, sha?)` — `sha` joins the query key,
  so commit hunks and working-tree hunks are separate cache entries and
  switching dots does not serve one as the other.
- `review-commit-scope.ts` (new, pure, tested): given a `ProjectReview` and a
  selected sha, return the rows to render — either `project.changedFiles` or the
  commit's `fileChanges` mapped to `ChangedFile` shape with `staged: false,
  unstaged: false`. This is the replacement for the intersection at line 445 and
  is a pure function precisely so the rule is testable without a panel.
- `ReviewCommitNav` renders the trailing dot: `aria-label="Uncommitted changes"`,
  active when `selectedSha === null`, `onSelect(null)`.
- `ReviewChangedFiles` takes `commit: { sha, shortSha } | null` and
  `onClearCommit: () => void`. When `commit` is set it renders the sha label with
  an `XIcon` button, omits `ReviewStagedFiles` and the "To review" heading, and
  passes the sha down so `ExpandedHunks` fetches commit hunks and renders
  `ReviewHunkList` with staging suppressed.

## 4. How this is verified

- `review-commit-scope.test.ts` — the row set for: no selection (working tree),
  a commit whose files are all clean (the case broken today), a commit with a
  rename, a sha not in the project.
- `review-status.test.ts` — `parseTurnCommits` over `--name-status` output:
  modify, add, delete, and `R100\told\tnew`.
- `review-git-integration.test.ts` — a real repo: commit a file, edit it again,
  and assert `readCommitFileDiff` returns the *commit's* hunks and not the
  working tree's; assert the root commit works.
- Route test for the 400 (sha outside this session's commits) and 404 (path not
  in commit).
- `npm run tsc`, `npm run lint`, `npm test`.

Manual check, which the automated ones cannot make: select a commit dot in a
session with commits, confirm the label shows the short sha with a close button,
that a committed-and-now-clean file appears, and that the trailing dot restores
the full uncommitted list.
