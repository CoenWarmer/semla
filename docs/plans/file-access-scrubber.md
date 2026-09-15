# Plan: file-access scrubber

Step through the files an agent read and wrote, in order, in the Review panel —
with the read line ranges highlighted, and a Follow mode that rides the newest
access while a turn is running.

**Superseded `review-panel-follow-mode.md`,** which is deleted: it was
unimplemented, its Phase 3 was a prerequisite for this one, and keeping both
would have left two designs competing for `ReviewPanel`'s target prop. Its
settled decisions are carried forward in full below.

## Decisions (settled with the operator, do not re-open)

Carried from the superseded plan:

- Only mutating tools (`edit`, `write`) **open** the panel. Read-type tools
  navigate it only if already open.
- Follow behaviour is a user-controllable toggle, default ON, persistent.
- Scope includes **live follow** and **historical replay**.

New:

- **Bash reads are in scope from the start.** A scrubber built only on typed
  tools would miss most of what the agent read — see §4.
- **Both turn-scoped and session-scoped**, with a toggle on the pill.
- **Subagent accesses are included, labelled by agent, and filterable.**

## 1. Why this is not a small feature

Three facts, each measured against this repository rather than assumed.

**The agent reads mostly through `bash`.** In session
`85716aa5-ef8b-43bd-849c-4cd2aab70271`, of 122 tool calls: 69 `bash`, 19 `read`,
14 `edit`, 11 `mcp`, 4 `write`, 3 `code_resolve`. The typed file tools are a
third of the traffic. A scrubber that ignores `bash` is not showing the operator
what the agent read.

**The disk artifact is richer than anything the client can currently see.** In
the persisted `.jsonl`, an `edit` result carries
`details: { diff, patch, firstChangedLine }` and a `code_resolve` result carries
`details.data.targets[]` with `file`, `displayLine`, `name` and `kind` — the
symbol anchor this feature wants. None of it reaches the browser:
[`getParams`](src/lib/pi/transcript.ts) keeps only scalar arguments, and
`buildTranscript` never reads `details` at all. This resolves open question 2 of
the superseded plan — `details` *is* persisted; it is the transcript layer, not
the session file, that drops it.

**`ReviewPanel` cannot currently be retargeted without a remount.** It reads
`initialTarget` once, in `useState` initialisers (lines 111–126), so
[`ClientSessionComponent`](src/components/client-session-component.tsx) forces a
remount with `key={elementTarget.target?.nonce ?? "manual"}` (line 758). Pressing
an arrow would discard `drafts`, `expanded`, `selectedCommitSha` and editor
scroll on every step.

## 2. Architecture

### 2.1 The record

One shape, produced server-side, consumed by both history and live. New module
directory `src/lib/pi/file-access/` — several small files rather than one, per
`AGENTS.md`.

```ts
export type LineRange = { start: number; end: number }; // 1-based, inclusive

export type FileAccess = {
  /** Tool call id, suffixed when one call yields several accesses. */
  id: string;
  /** Workspace-relative project path, or null when outside every linked project. */
  project: string | null;
  /** Project-relative when `project` is set; workspace-relative otherwise. */
  path: string;
  kind: "read" | "write";
  /** Empty means the whole file. */
  ranges: LineRange[];
  symbol?: { name: string; line: number; kind: string };
  agent: { id: string; label: string };
  /** TurnNode.id — the user message entry this descends from. */
  turnId: string;
  at: string;
  tool: "read" | "edit" | "write" | "code_resolve" | "bash" | "mcp";
  /** `bash`-derived accesses are inferred; everything else is exact. */
  confidence: "exact" | "inferred";
  /** The path did not exist when the timeline was built. Non-navigable. */
  missing: boolean;
};
```

`confidence` and `missing` are the two fields that make an imperfect parser
honest rather than misleading, and both are load-bearing — see §4 and §6.

### 2.2 Derivation happens on the server, from the session file

The client cannot do this. Path resolution needs `PI_WORKSPACE_ROOT`, the agent
cwd and the project links; `details` needs the raw entries; and the existence
check needs the filesystem. Reading the `.jsonl` directly also means no new
fields on `SessionToolCall`, whose `params: Record<string, string>` contract the
superseded plan was careful not to widen.

Per tool:

| Tool | Path | Ranges | Notes |
|---|---|---|---|
| `read` | `arguments.path` | `offset`/`limit` → one range; absent → whole file | `details.truncation` exists only when truncated |
| `edit` | `arguments.path` | from `details.firstChangedLine` | one observed result had an empty `details` — fall back to line 1 |
| `write` | `arguments.path` | whole file | |
| `code_resolve` | `details.data.targets[].file` | `displayLine` | also fills `symbol` |
| `mcp` (code search) | `details.matches[]` | per-match line | shape varies by mode; guard narrowly |
| `bash` | parsed from the command | parsed | `confidence: "inferred"` — §4 |

**Path → `{ project, path }`.** A tool's path is absolute or relative to the
agent cwd, which is not the workspace root: the session sampled above has
`cwd: /Users/coen/Dev` in its header while its commands `cd` into
`/Users/coen/Dev/semla`. Resolve to an absolute path first, make it
workspace-relative, then apply the same segment-wise longest-prefix rule as
[`selectionForWorkspacePath`](src/components/review/review-definition-target.ts)
— a string prefix is wrong, since `semla` prefixes `semla-wiki`. Extract that
rule into a shared pure function so the server and the panel cannot drift.

Accesses outside every linked project keep `project: null`. They stay in the
timeline and are counted, but the arrows skip them: "the agent read
`node_modules/typescript/…`" is information worth showing, and silently dropping
it would make the counter lie.

### 2.3 Subagents: read their transcripts, not the run file

A run file's `history` is `AgentHistoryEntry[]`, rebuilt by `compactAgentHistory`
at **40 entries / 2 000 chars / 20 000 total** — deliberately lossy, and worse,
[`agent-history.ts`](src/lib/pi/extensions/dynamic-workflows/src/agent-history.ts)
promotes `path` only for `write` and `edit`. A `read` survives as a JSON blob
inside `text`. Parsing that back would be a second, weaker extractor.

Instead: locate the subagent's own `.jsonl` with
[`findAgentTranscript(runId, label)`](src/lib/pi/workflow/workflow-agent-transcript.ts) and
run the **same** extractor over its raw entries. Subagent transcripts are written
into `PI_SESSION_DIR` under pi's `<timestamp>_<uuid>.jsonl` naming and linked by
`session_info.name === "workflow:<runId> <label>"`, so the format is identical to
the main session's.

Agent identity: `{ id: "main", label: "Main" }` for the host agent, and
`{ id: "<runId>:<agentId>", label: agent.label }` for subagents, where `label` is
already unique per run because transcript linkage depends on it. Runs come from
[`listWorkflowRuns(sessionId)`](src/lib/pi/workflow/workflow-run-index.ts).

**Cost warning.** `findAgentTranscript` lists `PI_SESSION_DIR` and reads the
first 16 KB of every `.jsonl` to match the name. That directory already holds 204
of them here, so a per-agent lookup is a ~3 MB scan and a workflow with eight
subagents would repeat it eight times. Build the name→path index **once per
timeline request** and pass it down.

### 2.4 Live: one resolved event, emitted at tool end

The SSE layer carries scalars only, so the client cannot derive an access from
`tool-start`. Rather than widening `params` and threading `details` through four
modules — the superseded plan's Phase 2 — emit the already-resolved record:

```ts
| { type: "file-access"; roundId: string; toolCallId: string; accesses: FileAccess[] }
```

Emit at **tool end**, where both arguments and `details` are available. Arguments
arrive at start, so stash them keyed by `toolCallId` and consume at end — exactly
the `pendingWrittenPaths` pattern already in
[`session-event-router.ts`](src/lib/pi/session/session-event-router.ts) for project
attach. Resolving server-side also settles the superseded plan's open question 1:
live and replay use one code path, with no client-side path guessing.

### 2.5 `initialTarget` → a controlled target

The load-bearing UI change, unchanged in substance from the superseded plan's
Phase 3. Replace `initialTarget` with `target?: ReviewTarget | null`, compared by
nonce **during render**, never in an effect:

- `chosen` becomes `useState<{ selection: FileSelection; nonce: number } | null>`;
  a manual click stamps a nonce from the panel's counter;
- `selection` is whichever of `chosen` / `target` has the higher nonce, else
  `defaultSelection(review.data)`;
- `reveal` likewise — the existing `{ line, nonce }` shape and the
  `revealLineNearTop` effect at `code-editor.tsx` 486–492 are reused untouched.

This satisfies `react/set-state-in-effect` — an **error** in `.oxlintrc.json` —
with no remount, so drafts survive a step. `ClientSessionComponent` then drops
the `key=` remount and routes the element picker's target through the same prop,
preserving its `precision` field so the "component" notice keeps working.

### 2.6 Follow is the scrubber's live tail, not a separate toggle

The superseded plan put a Follow button in the topbar. Now that a scrubber
exists, follow is better expressed as one of its modes: **Follow pins the index
to the newest access.** Pressing an arrow unpins it; pressing Follow re-pins.
That removes a control, and it removes the question of what the arrows mean while
following.

Storage stays as planned: `followMode: boolean | null` on
[`UserSettings`](src/lib/user-settings-store.ts), whose `writeUserSettings`
already merges patches so one screen cannot erase another's field. `null` means
on, encoded once in a `followModeEnabled(settings)` helper.

**Two things this needed that the plan did not anticipate.** The field has *no
Postgres column* and is deliberately not mirrored — nothing server-side reads
it, so a migration would be bought for a preference that only decides where one
panel scrolls. That makes the disk record the only copy, which in turn means
both handlers have to answer from it: a `PUT` that saved a model would otherwise
echo the database row, which has no `follow_mode`, and reset the client's copy
to the default.

And the pin is **two pieces of state, not one**. `followMode` is the saved
preference; `unpinned` is "I have stepped away from the agent for now" and lives
in the panel. Collapsing them would make pressing an arrow rewrite the
preference — turning following off in every future session, permanently, as the
side effect of looking at the previous file. So an arrow unpins and the Follow
button saves.

The open-vs-navigate asymmetry is unchanged: only `kind: "write"` accesses may
**open** a closed panel. `shouldOpenReview`'s `sessionRunning` guard stays as-is
— `review-open.test.ts` asserts it — and the new disjunct carries a docblock
saying the operator overruled that argument for mutating tools, or a future
reader will "fix" it back.

### 2.7 Decorations: reads only

Today's decorations are git-hunk derived: `added-line`, `added-span`,
`removed-marker`, mapped to Monaco in `optionsFor` (`code-editor.tsx` 63–90) with
CSS at `globals.css` 156–190.

Agent *writes* already show as the green diff wash, and the scrubber navigates
them to `firstChangedLine`, so **no new write decoration is needed** — adding one
would double-paint the same lines and compete with diff semantics. Only reads get
a new kind. Render them as a gutter band plus a very low-alpha background in a
neutral hue, never green or red, so the diff vocabulary stays intact.

**Amended in build: writes did get a mark, and the double-paint argument turned
out not to apply.** A write access carries `ranges` from the tool arguments, not
from the diff: an `edit` yields the single `firstChangedLine`, and a whole-file
`write` yields none at all and so paints nothing. So the mark is one line saying
*this is the edit the scrubber is on*, not a second wash over every changed line
— the case §2.7 was written against. It also covers the writes that have no diff
to double-paint: a file written and then committed, and anything the agent wrote
outside a git repository. Amber (`--chart-4`) at 9%, distinct from the green and
red three rules above it in `globals.css`, for the same reason reads are blue.

### 2.8 Where the pill lives

Not the header: its centre is held by `ReviewCommitNav`'s
`absolute left-1/2 -translate-x-1/2`, and the pill needs room for scope toggle,
agent filter, counter and arrows. Use the bar slot directly beneath the header —
the one the `precision === "component"` notice already occupies (`review-panel.tsx`
370–377), styled `border-b bg-muted/40 px-3 py-1` like the editor-pane notice
bars.

Contents, left to right: `‹` `›` arrows, `12 / 47`, the current file and range,
a `Turn | Session` segmented control, an agent filter (hidden when a session has
only the main agent), and the Follow toggle.

## 3. New and changed modules

**Create**

| Path | Role |
|---|---|
| `src/lib/pi/file-access/access-types.ts` | `FileAccess`, `LineRange` |
| `src/lib/pi/file-access/access-from-tool-call.ts` | typed tools → accesses |
| `src/lib/pi/file-access/bash-read-parser.ts` | §4 |
| `src/lib/pi/file-access/access-paths.ts` | cwd → workspace → project resolution, existence check |
| `src/lib/pi/file-access/access-timeline.ts` | ordering, turn scoping, agent labelling, dedup |
| `src/app/api/sessions/[id]/file-access/route.ts` | history endpoint |
| `src/components/review/review-access-scrubber.tsx` | the pill |
| `src/components/review/review-access-sequence.ts` | pure index/step/dedup logic |

**Modify** — `session-event-router.ts`, `session-events.ts`, `use-prompt-mutation.ts`,
`session-live-state.ts`, `review-panel.tsx`, `client-session-component.tsx`,
`review-decorations.ts`, `code-editor.tsx`, `globals.css`,
`user-settings-store.ts`, `src/app/api/user-settings/route.ts`,
`use-user-settings.ts`.

The route follows the auth-wrapped convention of
[`turn-graph/route.ts`](src/app/api/sessions/[id]/turn-graph/route.ts):
`export const runtime = "nodejs"`, awaited `params`,
`requireSessionOwner(id, undefined, { allowMissing: true })`, `handleRouteError`.
Not the review routes' pattern, which skip auth on a loopback assumption.

## 4. The bash parser

Measured against 4 237 `bash` commands from the 40 largest sessions in
`.semla-sessions/`.

**What the corpus looks like.** Splitting on `&&`, `||`, `;`, `|` and newlines
gives 24 224 segments — a mean of 5.7 per command and a maximum of **266**. The
most common segment verbs are `cd` (3 924), `grep` (2 327), `head` (1 351),
`echo` (1 122), `git` (877), `sed` (752), `cat` (707), `tail` (628). Verbs like
`const`, `import`, `print` and `console.log` also appear in the top 30, which is
the signature of heredocs: 174 commands (4%) contain `<<`, and a naive split
walks straight into the embedded JavaScript or Python.

**Rules.** Strip heredoc bodies first, then split into segments, tracking `cd` to
maintain a cwd. Recognise `sed -n N,Mp`, `cat`, `head -n N`, `tail -n N`,
`awk 'NR==…'`, and `grep`/`rg` naming a file. Writes: `>` / `>>` (136 commands,
3%), `tee`, and `sed -i` (15 commands).

**Two rules that came out of getting it wrong.** Extension alternation must be
longest-first: a prototype with `(?:ts|…|js|jsonl)` harvested `events.js` out of
`events.jsonl` and depressed apparent precision by fourteen points. And cwd
tracking is not optional — without it, bare basenames like `agent.ts` after a
`cd` do not resolve at all.

**Measured yield.** 1 420 of 4 237 commands (33%) produce at least one access,
1 647 extractions in total. Checking each against the filesystem:

| | resolves to a real file |
|---|---|
| without cwd tracking | 69% |
| with cwd tracking | **86%** |

The residual 14% is dominated by files that existed when the session ran and have
since moved or been deleted — `src/components/session-topbar.tsx`,
`.pi/settings.json` — not by parser noise. That is what `missing: true` is for:
the entry stays, showing the operator that the agent read a file that is now
gone, and the arrows skip over it rather than opening a 404.

**The parser reads arguments, never results.** This is deliberate. The
[`read-router`](src/lib/pi/extensions/read-router.ts) extension replaces large
tool results with cheap-model summaries before they are persisted — `grep`/`find`
output above 40 lines, `ls` above 80 — so results are not a stable substrate.
Parsing arguments sidesteps it entirely. The cost is that a `grep -n` yields the
file but not the matched lines, so it lands as a whole-file access. That is the
right trade: a whole-file entry is honest, a line number parsed out of a
model-written summary is not.

## 5. Phases

Each phase ends green on `npm run tsc`, `npm run lint` and `npm test`.

### Phase 1 — the record and the typed-tool extractor
**Create.** `access-types.ts`, `access-from-tool-call.ts`, `access-paths.ts` + tests.
**Verify.** `read` with and without `offset`/`limit`; `edit` with and without
`details.firstChangedLine`; `write`; `code_resolve` filling `symbol` from
`details.data.targets[]`; a path outside every project yielding `project: null`;
the `semla` / `semla-wiki` prefix case. Assert the mutating-tool set *against*
`writtenPath` in `session-project-attach.ts` so the two cannot drift.

### Phase 2 — the bash parser
**Create.** `bash-read-parser.ts` + test.
**Verify.** Fixtures taken verbatim from the corpus: a heredoc containing a
`const … require("./x.ts")` line yielding nothing; `cd semla && sed -n 330,400p
src/x.ts` yielding one ranged access at the right cwd; a 266-segment command
capped and deduped; `.jsonl` not truncated to `.js`; `sed -i` classified as a
write. Precision is a property of the fixtures, not a threshold in CI.

### Phase 3 — timeline assembly and the history route
**Create.** `access-timeline.ts`, `file-access/route.ts` + tests.
**Modify.** Nothing.
**Verify.** Route test in the style of `stream/route.test.ts` — import `GET`,
call with `{ params: Promise.resolve({ id }) }`, mock `session-auth`. Main agent
only at this phase. Turn grouping asserted against `session-turn-graph.ts`'s
`TurnNode.id`.

### Phase 4 — `ReviewPanel` accepts a controlled target
**Modify.** `review-panel.tsx`, `client-session-component.tsx`.
**Verify.** Observable: pick an element, type an unsaved edit, pick a second —
the panel jumps and the draft and `ReviewCommitBar`'s unsaved count survive,
where today they are wiped. Lint clean of `react/set-state-in-effect`.

### Phase 5 — the pill, over history
**Create.** `review-access-scrubber.tsx`, `review-access-sequence.ts` + test.
**Verify.** Observable: finish a turn, step through with the arrows, land on each
file at the right line. Unit-test the sequence logic: consecutive accesses to the
same file and range collapse to one stop; `project: null` and `missing` entries
are skipped by the arrows but counted; the `Turn | Session` toggle changes the
denominator.

### Phase 6 — read decorations
**Modify.** `review-decorations.ts`, `code-editor.tsx`, `globals.css`.
**Verify.** Observable: step to a `read` with `offset`/`limit` and see exactly
those lines banded, with a diff hunk in the same file still legible underneath.

### Phase 7 — live follow
**Modify.** `session-events.ts`, `session-event-router.ts`,
`use-prompt-mutation.ts`, `session-live-state.ts`, `review-panel.tsx`,
`client-session-component.tsx`, and the settings trio.
**Verify.** Observable: a turn that reads three files then edits one — the panel
stays shut through the reads and opens on the edit at the changed line; re-run
with it open and the reads navigate it. Extend `user-settings-store.test.ts`:
writing `followMode` does not erase `systemPrompt`.
**Caution.** `closeReview` also dismisses the review fingerprint so a refetch
cannot reopen. A follow-opened panel the operator closes mid-turn must not
reopen on the next edit. Record the closed nonce and require
`target.nonce > closedAtNonce` — a boolean will not do, since a later edit is a
genuinely new event.

### Phase 8 — subagents and the agent filter
**Modify.** `access-timeline.ts`, the route, the pill.
**Verify.** Observable: run a workflow, then confirm each subagent's reads appear
under its label and the filter narrows the sequence. Assert the name index is
built once per request, not once per agent.

## 6. Risks and open questions

1. **Parser precision is 86%, not 100%.** Mitigated by the server-side existence
   check plus `confidence` and `missing`, so a bad extraction is visible rather
   than a wrong file opening. Worth re-measuring on a fresh corpus after Phase 2,
   since the corpus here is this repository's own agent behaviour and may not
   generalise.
2. **There is no "selected turn" in the UI to follow.** `sessionPendingScrollKey`
   is one-shot and `viewingLeafId` selects a branch, not a turn. Phase 5 defaults
   turn scope to the newest turn on the current leaf. Wiring conversation clicks
   to a shared selected-turn key is deliberately deferred — decide before Phase 5
   whether it belongs there.
3. **Volume.** A long session can produce thousands of accesses. Dedup of
   consecutive identical stops is specified, but whether an operator wants to
   arrow through 400 stops at all is unknown; a per-file grouping mode may prove
   necessary. Do not build it before the pill has been used once.
4. **`applyLiveToolEvent`'s documented identity-on-no-change does not hold** —
   its no-op paths return `[...calls]`, a fresh reference, and its tests assert
   `toEqual` rather than `toBe`. Not caused by this work, but the new
   `file-access` fold should not copy the pattern, and the discrepancy is worth
   a separate fix.
5. **Subagent transcripts may be absent.** `persistAgentSessions` degrades to
   in-memory when the session directory is not writable, and runs from before the
   transcript feature have none. The agent filter must handle an agent with no
   recoverable accesses without implying it read nothing.
6. **Three paths in the superseded plan are stale** and are corrected here:
   `session-topbar.tsx` is at `src/components/session/`, `session-steps-strip.tsx`
   and `session-conversation.tsx` at `src/components/conversation/`.
7. **Not verified:** whether any test asserts `ReviewPanel`'s
   `initialTarget`-on-mount contract or the `key=` remount. None was found; if
   one exists it needs updating in Phase 4.
