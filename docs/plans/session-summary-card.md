# Session summary component

## Goal

A single component that answers "what did this session do" at a glance:
title, goal, model, cost, agents/workflows involved, and everything that
went in (specs, plans, wiki pages surfaced/read) and came out (diffs,
commits, PRs, wiki pages written).

## Existing building blocks (do not re-derive)

Everything this component needs is already computed somewhere; the work is
assembly and layout, not new data plumbing, except for the wiki-read/wiki-write
tracking called out in Gaps below.

| Field | Source |
|---|---|
| Title, goal, projects | `SessionMeta` (`src/lib/pi/session/session-meta.ts`) — `title`, `goal`, `projects` |
| Model used | `SessionMeta.model` (`{ modelId, provider }`); for multi-agent sessions also `WorkflowAgentSnapshot.model` per agent |
| Total cost / tokens | `sessionUsageTotals()` (`src/lib/pi/session/session-usage-totals.ts`) → `SessionUsage { cost, tokens }`; render via `TokenUsage` (`src/components/token-usage.tsx`) |
| Workflows + their models | `WorkflowSnapshot.agents[].model` (`src/types/workflow.ts`), grouped by run; `countSessionAgents()` (`src/lib/session/session-agent-counts.ts`) for running/idle counts |
| Plan files created | `ArtifactSummary.plans` / chips with `role.name === "plan"` (`src/lib/artifacts/artifact-summary.ts`) |
| Feature specs captured | `ArtifactSummary.specs` / spec chips, popover pattern in `src/components/sidebar/spec-chip-popover.tsx` |
| Commits generated | `ArtifactSummary.commits` / commit chips |
| Uncommitted diffs | `ArtifactSummary.diffs` / diff chips (files still dirty) |
| PRs generated | `ArtifactSummary.prs` / pr chips (external link, no target) |
| Wiki pages surfaced (recall) | `SessionTranscriptEntry.wikiRecall` per turn (`src/lib/pi/transcript.ts`, `src/lib/pi/session/session-file.ts`) — currently rendered per-message via `WikiRecallBadge` (`src/components/conversation/message-edit.tsx`), not aggregated per session |

## Gaps — needs new plumbing

1. **Which wiki pages the agent actually opened (read)**, as opposed to
   which were offered by recall. Recall only tells us what was *injected*;
   nothing currently records which of those (or which searched-for pages)
   the agent chose to `read`. This needs a scan of the transcript's tool
   calls for `read` invocations whose path matches a wiki page under
   `.llm-wiki/wiki/**`, or a dedicated record if the wiki extension exposes
   one — needs a short investigation spike before implementation.
2. **Wiki items generated** (pages/observations written this session) —
   likely obtainable the same way, by scanning tool calls for
   `wiki_ensure_page` / `wiki_observe` / `wiki_retro` calls and their
   results, but there is no existing aggregation; needs the same spike.
3. **Aggregating `wikiRecall` per session** rather than per-message — sum
   across all transcript entries.

## Component shape

`SessionSummaryCard` (or similar), pure/presentational, consuming a single
already-assembled `SessionSummary` data object (mirrors the
`ArtifactSummary` pattern: compute once server/hook-side, render dumbly).

```
SessionSummary = {
  title: string | null
  goal: string | null
  projects: string[]
  usage: SessionUsage            // cost + tokens
  model: { modelId, provider } | null
  workflows: { runId, name, agentModels: string[] }[]
  artifacts: ArtifactSummary      // specs, plans, diffs, commits, prs — reuse as-is
  wikiRecalled: { title, path }[] // pages injected into context (from wikiRecall)
  wikiRead: { title, path }[]     // pages the agent opened (NEW, see gap 1)
  wikiWritten: { title, path }[]  // pages/observations created (NEW, see gap 2)
}
```

Rendering reuses existing pieces where possible:
- `TokenUsage` for cost/tokens.
- `SessionArtifactChips` / `CountStrip` pattern for specs/plans/diffs/commits/prs
  (either embed it directly or factor its per-kind chip-row rendering so this
  card and the sidebar row share it).
- A new small "wiki" row (recalled / read / written counts, each with a
  popover listing pages) following the same chip-and-popover convention as
  `SpecChipPopover`.

## Decisions (operator, this session)

1. **Placement.** The card renders in the same resizable column that
   currently renders `SessionConversation` (`conversationColumn` in
   `src/components/client-session-component.tsx`). That column is split
   into two horizontal (side-by-side) resizable panels — conversation on
   one side, the summary card on the other — matching the existing
   `reviewLayout: "horizontal" | "vertical"` convention where "horizontal"
   already means side-by-side (`src/components/session/session-topbar.tsx`'s
   `reviewLayout` prop, and the comment on it in
   `client-session-component.tsx`). This nests inside the existing
   review/conversation `ResizablePanelGroup`: `conversationColumn` becomes
   its own `ResizablePanelGroup` (orientation `"horizontal"`) with two
   `ResizablePanel`s, following the same `usePanelLayoutSaver` /
   `usePanelLayouts` persistence pattern (a new layout key, e.g.
   `session-summary-split`) so the drag position survives reload the same
   way `review-split-${reviewLayout}` does.
2. **Wiki read/write tracking ships in v1.** Gaps 1 and 2 above (which wiki
   pages the agent read, which it wrote) are in scope for the first version,
   not deferred. The investigation spike for how to derive them from the
   transcript happens as part of phase 1, not as an optional follow-up.
3. **Multi-agent sessions get a per-agent breakdown**, not one dominant
   model. The card lists each workflow's agents with their own model and
   cost (`WorkflowAgentSnapshot.model`, `.cost`, `.tokens` — already present
   per agent in `src/types/workflow.ts`), grouped by run/phase.

## Suggested phases

1. **Data assembly + wiki spike** — a `sessionSummaryFor(sessionId)`
   function joining `SessionMeta`, `sessionUsageTotals`, workflow run
   snapshots (per-agent, not collapsed), and the existing `ArtifactSummary`;
   plus the transcript scan for wiki-read (tool calls opening a
   `.llm-wiki/wiki/**` path) and wiki-written (`wiki_ensure_page` /
   `wiki_observe` / `wiki_retro` calls) tool calls, and aggregation of
   `wikiRecall` across all transcript entries (currently only rendered
   per-message).
2. **Component** — `SessionSummaryCard` rendering phase 1's data: header
   (title/goal/projects), total cost/tokens via `TokenUsage`, per-agent
   model/cost breakdown, artifact chip rows (reusing the
   `SessionArtifactChips`/`CountStrip` pattern for specs/plans/diffs/commits/
   prs), and a wiki row (recalled/read/written, each with a chip-and-popover
   list following the `SpecChipPopover` convention).
3. **Layout wiring** — split `conversationColumn` into a nested
   `ResizablePanelGroup` (conversation + summary card), wired to
   `usePanelLayouts`/`usePanelLayoutSaver` under a new layout key, mounted
   inside the existing outer group in `client-session-component.tsx`.
