# Plan: forking a conversation, and navigating its branches

**Goal:** fork a session at any message, and see and move between the resulting
branches in a graph panel — clicking a branch makes it the conversation.

**Status:** designed 2026-09-04, not started.

---

## 1. Most of this already exists

A Pi session is already a tree, not a list. Every entry carries a `parentId`,
and Semla already reads it as one:

- `activePath` in `session-path.ts` walks root to leaf and is what makes
  abandoned paths disappear from the UI;
- `supersededSiblings` in the same file already computes, for every entry on the
  live path, the siblings it replaced — and `liveMessageRows` already attaches
  them to the row as `superseded`. The data the graph needs is being computed
  today and thrown away by the renderer;
- `session-branch.ts` already moves the leaf. Editing a prompt forks the session
  right now; it is simply not called forking and produces no visible branch;
- `code-map-panel.tsx` is a working React Flow panel with elk layout in
  `code-map/layout.ts` — the graph is a second instance of a pattern that
  already works here, not a new one;
- the message gutter that would host the button exists at
  `client-session-component.tsx:571`, already holding copy and edit.

So the feature is mostly assembly. There is exactly one thing missing, and it
is the whole difficulty.

---

## 2. The missing piece: nobody remembers which branch you are on

Pi's `SessionManager` holds `private leafId` **in memory**. `getLeafId()` reads
it, `branch()` moves it — and reopening a session forgets it. As
`session-path.ts` records, `buildSessionPath` then resolves the leaf as
`entries[entries.length - 1]`.

That is fine while the leaf is only ever moved transiently, which is all Semla
does today: `runPiPrompt` moves it just before a turn so an edited prompt lands
in the right place. It is not fine for branch *navigation*, where the whole
point is that the choice outlives the click.

**Decision: Semla owns the leaf and stores it in `SessionMeta`.** That file
already holds the title, goal, projects, model and usage, on disk, authoritative
— a `leafId: string | null` belongs beside them.

### The contract this must not break

`session-path.ts` carries a warning worth quoting, because it is the first
objection any reader will raise:

> the leaf rule here is a contract with Pi, not a preference … Choosing any
> other leaf would put the UI back out of step with the model — quietly, and in
> exactly the same way.

That warning is about the UI *unilaterally* choosing a different leaf from the
one the model continues from. Storing a leaf does not do that, provided it is
applied to **both** sides: the transcript walk reads it, and `runPiPrompt`
applies it through `branch()` before appending anything. The rule becomes "the
leaf is the one Semla recorded, defaulting to the last entry when it has
recorded none" — a strengthening of the contract rather than a departure from
it. `session-path.test.ts` pins the current rule and would need to pin the new
one.

---

## 3. What "fork" means, precisely

Two operations that share a mechanism and must not share a name:

| | Leaf moves to | Effect |
|---|---|---|
| **Edit** (exists) | the message's **parent** | The next prompt *replaces* that message |
| **Fork** (new) | the message **itself** | The next prompt *continues from* it, keeping it |

**A fork does not create a branch.** It repositions the leaf; the branch
materialises when the next prompt is appended as a second child. This matters
for the UI: immediately after forking, the conversation visibly truncates to
that message and there is one path, not two. The panel must show "you are
forked here, nothing has diverged yet" rather than promising a branch that does
not exist. Getting back is just switching the leaf to the other tip.

---

## 4. The graph panel

**Node granularity is the real design problem.** One node per entry is
unusable: the MCP session has 1,013 entries. The unit people think in is the
turn — a user message and everything the agent did in reply. `session-steps.ts`
already groups the conversation for the steps strip; whether its grouping is the
right one here should be checked before a second one is written.

Proposed: **one node per turn**, with a fork point rendered as the node where
edges diverge. A node shows its prompt's first line, its entry count, and
whether it is on the live path. Edges are parent to child.

Layout with elk, as `code-map/layout.ts` does — it is asynchronous, so positions
arrive a tick after the tree, which `code-map-panel.tsx` already handles.

**Clicking a node switches the leaf** to that branch's tip and the conversation
re-renders. That is the same write as forking, aimed at a different entry.

The panel belongs in the bottom bar, through the slot mechanism
`bottom-panel.tsx` documents: the bar owns which panel is open, the session
portals its content in, one at a time. The graph's data belongs to the session
subscription, which is exactly the split that mechanism exists for.

---

## 5. Phases

**1 — A durable leaf, no UI.** `leafId` on `SessionMeta`; the transcript walk
reads it; `runPiPrompt` applies it before appending. This is the whole
correctness surface, and it is independently useful: it is also what
`superseded-turns.md` phase 5 needs to offer recovery of an orphaned branch.

**2 — The fork button**, beside copy and edit. Fork sets the leaf to that
message. The conversation truncates; an affordance says so.

**3 — The graph, read-only.** Turn-level nodes, elk layout, live path
highlighted, abandoned branches dimmed. Valuable on its own: today a branched
session gives no sign that other paths exist.

**4 — Click to switch.** The same write as phase 2, from the graph.

**5 — Polish.** Naming a branch, pruning one, and cost per branch — the usage
data is already stamped per session but not per path.

---

## 6. Risks

| Risk | Mitigation |
|---|---|
| Stored leaf and pi's in-memory leaf drift apart | One chokepoint: `runPiPrompt` already moves the leaf before a turn, so it applies there and nowhere else |
| A stored leaf naming an entry that no longer exists — pi has `_rewriteFile`, and compaction rewrites history | Fall back to the last entry and say so, never fail the read |
| Two turns racing to move the leaf | The failure `superseded-turns.md` describes; that plan lands first or this one inherits it |
| A thousand-entry session renders an unreadable graph | Turn-level nodes; collapse long linear runs to a single edge with a count |
| Compaction and branch-summary entries are structural, not conversational | `buildContextEntries` already handles them on pi's side; the graph must not draw them as turns |
| Forking mid-turn | Refuse while a turn is live, the way the review panel refuses to open then |

---

## 7. Alternatives considered

**Fork into a new session** — copy entries up to the chosen message into a fresh
session file. It sidesteps the leaf problem entirely, since each session keeps
one path and needs no stored pointer, and it makes two conversations
independently resumable.

Rejected as the primary model because it loses the thing that was asked for: one
session whose branches can be seen together and moved between. It remains the
better answer for "take this somewhere else and leave the original alone", and
is worth adding later as a second, clearly distinct action.

---

## 8. Deferred

- Merging branches. Conversations do not merge; the graph is a tree and should
  stay one.
- Diffing two branches.
- Automatic forking — for instance on a superseded turn. Recovery should be
  offered, not performed.
