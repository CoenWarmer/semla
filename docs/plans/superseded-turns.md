# Plan: a superseded turn must not append to the transcript

**Goal:** stop a tool call that outlives its turn from appending to the session
and taking the conversation with it. Then decide, per tool, whether such a call
should be killed or merely ignored.

**Status:** diagnosed 2026-09-04 from a session where it happened, not started.

This is not the problem `session-isolation.md` describes. That one is several
sessions sharing a working tree. This is one session racing itself, and it needs
fixing whether or not sessions are ever isolated.

---

## 1. What happened

Session `57548803-3fbb-455d-beb2-47f20a5de6f2`. The operator's account was that
the UI showed a long summary after many tool calls, then reloaded and showed a
single short message instead.

The transcript is a tree, and it forked:

```
e83f05f4  20:59:24  assistant, containing  bash: find / -iname "*8d852abe*"
  ├── b4d51886  20:59:51  user: "why did you search through all of the file
  │                        system instead of just Semla?"   → 63 descendants,
  │                        ending at 51fb7e85 (21:05:21) with the 3,007-character
  │                        summary the operator remembers
  └── b158e55d  21:07:09  toolResult: the find, returning after 7m45s
                          → assistant "Yes, I can see it…" (21:07:13)
```

The operator sent a new prompt 27 seconds into a filesystem-wide `find`. That
prompt was appended as a child of the assistant entry and a new turn ran to
completion. Nearly eight minutes later the original `find` returned, and its
result was appended as a *second* child of the same parent — arriving last, and
therefore becoming the last line in the file.

**Nothing was lost.** Every entry is still on disk. The 63-entry branch is
simply not on the path anything walks.

---

## 2. The reader is not at fault

`activePath` in `session-path.ts` resolves the leaf as
`entries[entries.length - 1]`, and its docblock is explicit that this is not a
preference:

> the leaf rule here is a contract with Pi, not a preference. `buildSessionPath`
> in the package's session-manager.js resolves the leaf as
> `entries[entries.length - 1]` when it is not told otherwise. Choosing any
> other leaf would put the UI back out of step with the model — quietly, and in
> exactly the same way.

So the fix cannot be "pick a different leaf". A UI that displayed the long
branch while the model continued from the short one would reintroduce the
divergence that rule was written to end. The append is what must not happen.

---

## 3. The defect

`runPiPrompt` does not check whether a turn is already live. It calls
`abortBackgroundContinuation`, which handles a waiting background delivery, and
nothing else; `getLiveSession` is consulted only by `isSessionActive` and by
`stopPiSession`, which the /stop route calls. The prompt route has no guard of
its own.

So a second prompt starts a second turn beside the first, both write to one
session file, and ordering is decided by whichever tool happens to return last.

---

## 4. Decision: always drop, abort selectively

These are two changes and the plan keeps them apart deliberately.

**Dropping is the correctness fix.** A result whose turn has been superseded
must never reach the session's append path. It is unconditional, it has no
side-effect risk, and it fixes the failure above completely. Nothing below
changes whether it should be done.

**Aborting is a cost and safety optimisation.** Whether the underlying process
is also killed is a separate, per-tool judgement that can be tuned later without
reopening the correctness question. Bundling the two is how a codebase ends up
unable to change one without risking the other.

Worth knowing before designing that half: **pi's abort is not gentle.** Its bash
tool handles the signal, in its own words, "by killing the entire process tree".
So "let it run, ignore the result" is not what abort does by default — it takes
deliberately *not* forwarding the signal.

### The per-tool policy

| Tool | On supersession | Why |
|---|---|---|
| `read`, searches, `code_map`, `wiki_*` | Abort | Pure reads. Killing them costs nothing and frees I/O |
| `workflow`, subagents | Abort | The expensive case. They bill for output already decided against, and touch no files, so killing is safe |
| `edit`, `write` | Let finish | Fast and bounded; abort is close to moot and a half-written file is worse than a stale one |
| `bash` | **Let finish, drop the result** | Arbitrary. Killing `npm install` or a git operation mid-flight can leave a worse tree than letting it complete — a half-populated `node_modules`, or the `index.lock` AGENTS.md already treats as a hazard |

---

## 5. Who decides whether a call is abortable

**Not the model, at supersession time.** It would need a round trip at exactly
the moment the operator has signalled they want something else now; it cannot
observe whether `npm install` is five per cent or ninety-five per cent through;
and the agent whose turn was just abandoned is a poor judge of whether its own
work deserves to survive.

**Mostly not the model at all.** The table above is static, needs no tokens, and
can be tested. The ambiguity collapses onto one tool.

**Not by reading the command string.** For `bash`, the tempting move is to
inspect the command and decide. This repository has already rejected that
reasoning once, in `session-project-attach.ts`, which declines to infer writes
from shell commands "rather than papered over with a shell parser that would be
wrong in ways nobody could predict". Guessing whether a command is safe to kill
is the same mistake in different clothes.

**The model, at call time, opt-in only.** It does know intent — that a sweep is
read-only — and can say so when it issues the call. The property that makes this
safe is that a call may declare itself *abortable* and may never declare itself
*un-abortable*. A mislabel then costs wasted work and never a mutation killed
half-way.

### The lever that already exists and is unused

Pi's bash tool takes a `timeout`, described to the model as "Timeout in seconds
(optional, **no default timeout**)". The `find /` ran for 7m45s because no
timeout was given; the ceiling is about 24 days.

Injecting a default when the model omits one is the cheapest change here and is
mechanism rather than instruction. Its benefit should not be overstated: it
bounds runaways, and would only have caught *this* case if set below eight
minutes. A five-minute default would have; ten would not.

---

## 6. Phases

**1 — Do not append a superseded result.** A turn gets an identity; results
arriving for a turn that is no longer current are discarded before the session
manager sees them. This is the fix; everything else is optional.

**2 — Record the drop.** A discarded result must be visible. Semla's product is
traceability, and eight minutes of `find /` vanishing without trace is the same
class of failure as the orphaned branch — work that happened and left no
evidence. The span should say *superseded; result discarded*.

**3 — The per-tool abort policy** from §4, as a table in one place with a test.

**4 — A default bash timeout** when the model gives none.

**5 — Surface the orphaned branch.** `supersededSiblings` already computes
abandoned siblings, and `applyBranchTarget` already moves the leaf — that is how
prompt editing works. What is missing is the offer: *this session has an
abandoned branch with 63 entries; switch to it.* Without it, the recovery path
is editing a JSONL file by hand.

**6 — Optional: model-declared abortability**, opt-in only, per §5.

---

## 7. Risks

| Risk | Mitigation |
|---|---|
| Dropping a result the agent needed leaves its world-model wrong about the filesystem | Largely self-healing — the review panel reads `git status` rather than trusting tool observation, for this reason — but phase 2's record is what makes it diagnosable |
| A default timeout kills a legitimate long build | Generous default; the model can already raise it per call |
| Aborting subagents mid-flight leaves partial workflow state | Workflow state is already reconstructed from run files; assert it |
| Turn identity threaded through the wrong seam | It has to sit where results enter the append path, not at the route |

---

## 8. Deferred

- Refusing a second prompt while a turn is live. It would prevent this, and it
  would also remove the operator's ability to redirect an agent that is visibly
  doing the wrong thing — which is exactly what happened here, and was the
  right instinct.
- Inferring abortability from the command string. See §5.
- Showing both branches side by side. Switching is enough.
