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

**Decision: the leaf lives in three places, each answering a different
question.** An earlier draft of this plan put it solely in `SessionMeta`, which
conflates viewing a branch with committing to it.

| Where | Answers | Why there |
|---|---|---|
| **The URL** — `?leaf=<entryId>` | *Which branch am I looking at?* | Shareable, and the browser's back and forward buttons become branch navigation for free — which is what switching branches actually is |
| **The prompt request** | *Which branch does this turn continue from?* | The client sends the leaf with the prompt and the server applies `branch()` before appending. No ambient state decides where a turn lands |
| **`SessionMeta`** | *Which branch by default?* | Only a fallback, for the cases with no browser: a background continuation, a resumed session, a fresh tab with no parameter |

The property that makes the URL the right home is that **looking is not
writing**. With the leaf held only on the server, clicking through branches to
read them mutates the session and changes where the next turn would land — even
though the operator was only looking. In the URL, browsing costs nothing, two
tabs can sit on two different branches, and a link to a branch is a link
someone else can open.

`SessionMeta` still has to hold something, because a turn can start without a
browser attached. It records the leaf a turn last actually ran from, not every
branch that was glanced at.

### The contract this must not break

`session-path.ts` carries a warning worth quoting, because it is the first
objection any reader will raise:

> the leaf rule here is a contract with Pi, not a preference … Choosing any
> other leaf would put the UI back out of step with the model — quietly, and in
> exactly the same way.

That warning is about the UI *unilaterally* choosing a different leaf from the
one the model continues from. Naming the leaf explicitly does not do that — it
does the opposite, provided the same value reaches **both** sides: the
transcript walk resolves it, and `runPiPrompt` applies it through `branch()`
before appending anything. Carrying it on the request is what makes that hard to
get wrong: the view the operator was looking at and the branch the turn
continues is one value travelling together, rather than two pieces of state that
have to be kept in agreement.

The rule becomes "the leaf is the one the request names, falling back to the
recorded default and then to the last entry" — a strengthening of the contract
rather than a departure from it. `session-path.test.ts` pins the current rule
and would need to pin the new one.

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

**Read the parameter on the client, not in the page.** `sessions/[id]/page.tsx`
is a server component that runs a Supabase query and `buildSessionMessages`
before it renders; it already takes `searchParams` for `?new=`. Reading `?leaf=`
there would re-run that whole payload on every branch click. It belongs in
`useSearchParams` inside the client component, as part of the message query's
key, so switching a branch is one API call rather than a full server render.
Navigate with `push` rather than `replace`, or back and forward — half the value
of putting it in the URL — will not work.

The panel belongs in the bottom bar, through the slot mechanism
`bottom-panel.tsx` documents: the bar owns which panel is open, the session
portals its content in, one at a time. The graph's data belongs to the session
subscription, which is exactly the split that mechanism exists for.

---

## 5. Phases

**1 — The leaf becomes an explicit parameter, no UI.** The transcript read
accepts a leaf; the prompt request carries one and `runPiPrompt` applies it
through `branch()` before appending; `SessionMeta` records the one a turn last
ran from, as the fallback. This is the whole correctness surface, and it is
independently useful: it is also what `superseded-turns.md` phase 5 needs to
offer recovery of an orphaned branch. `?leaf=` can land with it or with phase 3
— nothing else depends on the order.

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
| A shared `?leaf=` link goes stale as that branch grows past the entry it names | Treat the parameter as naming a *branch*, not a position: resolve it to the current tip of the branch that entry is on. Pinning an exact entry would make every shared link rot |
| `?leaf=` pointing at an entry in a different session | The walk already refuses an unknown id — `EntryNotFoundError` exists for this; fall back to the default and say so |
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
