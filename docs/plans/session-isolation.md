# Plan: isolating concurrent sessions from each other

**Goal:** let several Semla sessions work on the same repository at once without
committing, staging or destroying each other's work.

**Status:** designed 2026-09-04, not started. Phase 1 is small and worth doing on
its own; phase 2 is the one that actually isolates, and is deliberately scoped
narrowly to begin with.

---

## 1. What is true today

**There is no isolation of any kind.** Every session working on a project runs
in that project's directory — `session-cwd.ts` resolves a session to its anchor
project precisely so an LSP workspace is not stood up over all 50 repositories —
and nothing narrows it further. Two sessions working on `semla` share one
directory, one index, and one HEAD.

Nothing serialises them either. `live-sessions.ts` keeps an in-process registry
of running sessions and `isSessionActive` answers for one at a time; there is no
lock, no queue, and no per-project claim.

`session-branch.ts` sounds relevant and is not: it is about moving a Pi
conversation's leaf pointer when a prompt is edited, not about git branches.

This was not hypothetical while the plan was being written. A Semla session was
live in this repository with ten modified files, and Claude Code was editing the
same checkout as a third actor.

---

## 2. What actually goes wrong, worst first

**1. The index is shared.** This is the one that cannot be mitigated by care.
`git add` followed by `git commit` in session A includes whatever session B has
staged. The review panel makes it sharper rather than safer: it stages chosen
hunks by path into that same index, so "approve these three hunks" can commit a
file another session is still editing. The failure is silent, it produces a
commit whose message describes work it does not contain, and it lands in the
middle of the traceability story this application exists to tell.

**2. Destructive commands reach everyone.** `git stash`, `git checkout --`,
`git reset --hard` operate on the whole tree. AGENTS.md now forbids the first
two, for reasons that hold even for a single session — but a rule that holds
"even alone" is not a concurrency mechanism.

**3. Concurrent edits to one file.** Last write wins, with no marker. Less
likely than it sounds — sessions usually work in different files — and the
review panel's `sha` guard already refuses a blind overwrite on save.

**4. Review attribution is whole-tree.** `recordTurnStart` fingerprints every
changed file in the project, so session A's edits appear in session B's review
as "changed this turn", and B's commit bar offers to stage them.

---

## 3. Why the answer is not an AGENTS.md rule

An instruction to "check whether another agent is running before working" fails
on three counts, and the first is fatal.

It cannot touch the index. By the time an agent has checked, seen another
session, and decided to proceed anyway — which it must, or concurrency is
pointless — it still shares one index with that session.

It is a request rather than a mechanism. This repository has already made that
call twice, most recently in `docs/plans/review-panel.md` §3.1: forbidding the
agent to commit was rejected because "a prompt rule is a request, and a model
that commits anyway produces exactly the silent gap the rule was meant to
close." Reading git was preferred because a fact cannot be disobeyed. The same
reasoning applies here and points the same way.

And it does not say what to do about the answer. Wait for how long? Refuse the
turn? Two sessions can both check, both see the other, and both proceed.

**The half of the idea that is right** is that concurrency should be *visible*.
That belongs in the harness, where it is a fact, rather than in the prompt,
where it is a hope. Phase 1.

---

## 4. Phase 1 — make concurrency visible

Semla already holds both halves: `live-sessions.ts` knows which sessions are
running, and `sessionProjects(id)` knows which projects each one is linked to.
Intersecting them answers "who else is working in this project right now"
without any new bookkeeping.

- Surface it in the session UI, beside the project name: *2 other sessions are
  working in semla.*
- Put the same fact in the turn's context, so the agent knows without being
  asked to check.
- Surface it in the review panel especially, where it explains why the changed
  list contains files this session never touched.

No behaviour changes. Nothing is blocked. It costs one derived query and it
turns a silent condition into a visible one, which is worth doing whether or not
phase 2 ever happens.

---

## 5. Phase 2 — worktrees, opt-in, Semla's own repository first

A `git worktree` gives a session its own working tree, its own index and its own
HEAD. That is exactly the set of things §2 lists as shared, which is why this is
the mechanism rather than a mitigation.

It also fixes something else for free. A session working on Semla in a worktree
is no longer editing the files the running `next dev` serves, so the Turbopack
churn that AGENTS.md's stash section describes stops being possible at all.

**Start with Semla's own repository, opt-in per session.** It is where the harm
is worst — an agent editing the application it is running inside — and it is the
cheapest to check out: 643 tracked files against kibana's 121,481. A blanket
default across every project would make each session on a large monorepo pay for
a full checkout, and would change the operator's workflow everywhere at once.

### The trap that has to be handled at creation

**A fresh worktree has no `node_modules`, so `npm run tsc` and `npm run lint`
pass there without checking anything.** Silently. That is worse than a worktree
that fails outright, and it is the single detail most likely to make this
feature a net negative if it is left to a follow-up. Symlinking `node_modules`
from the primary checkout has to be part of worktree creation, and there should
be a test that a created worktree can actually fail a type error.

### What it touches

| Seam | Change |
|---|---|
| `session-cwd.ts` | Resolve a session to its worktree, not the shared project directory |
| `projectAbsolutePath()` in `session-project.ts` | The chokepoint every git and review route already derives paths from |
| `resolveReviewTarget()` in `review-service.ts` | Already the single allowlist chokepoint; resolves through the worktree |
| `resolveFileRoot()` in `file-browser.ts` | File tree and content routes |
| `ProjectLink` in `session-meta.ts` | Needs to record the worktree, so a resumed session finds it again |
| Creation / teardown | `git worktree add` on a session-named branch, `node_modules` symlink, and a decision about when a worktree is removed |

---

## 6. Phase 3 — integration

Each session's work ends on its own branch, which is a workflow change for the
operator and the part most likely to be disliked. The review panel already
commits per project and would commit on that branch; `git-actions.ts` already
has `mergeIntoCurrent`. What is missing is the surface: which branch a session is
on, what is on it, and how it comes back to main.

Deliberately last. It is easier to judge what integration should feel like after
living with phase 2 than to design it in advance.

---

## 7. Risks

| Risk | Mitigation |
|---|---|
| A worktree without `node_modules` passes checks silently | Symlink at creation; a test that a worktree can fail a type error |
| Disk and time on large repositories | Opt-in, Semla's own repo first; never a blanket default |
| Branch proliferation the operator has to integrate | Phase 3; keep phase 2 opt-in until that is understood |
| Paths derived from `process.cwd()` in `runtime-config.ts` | Those are the *server's* cwd, not the agent's, and are unaffected — but worth asserting, because a wrong answer here silently loads the wrong extension |
| Sessions resumed after a restart cannot find their worktree | Record it on the `ProjectLink`, not in memory |
| Phase 1 alone might be mistaken for a fix | It is not: it makes the problem visible, it does not stop it |

---

## 8. Deferred

- Locking or serialising writes per project. It removes the value of concurrent
  sessions to solve a problem isolation solves better.
- Worktrees for every project by default. Revisit once Semla-on-Semla has run
  on them for a while.
- Detecting and merging conflicting concurrent edits to one file. Rare, and the
  review panel's `sha` guard already refuses the blind overwrite.
