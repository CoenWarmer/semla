# Client components must not call fetch directly; use React Query hooks

**Status:** accepted

A client component (`"use client"`) must never call `fetch` itself. Server
communication is abstracted behind a hook in `src/hooks/` that wraps React
Query (`useQuery` / `useMutation`), and the component calls that hook instead.

We decided this because several client components already call `fetch`
directly — for example `projects-combobox.tsx` and `model-tier-editor.tsx`
call `/api/projects` and `/api/models` inline — while most server
communication already goes through a `use-*` hook backed by React Query
(`use-models.ts`, `use-skills.ts`, `use-review.ts`, and others). The two
styles coexist today, and without a stated rule the inline-`fetch` style
keeps getting copied into new components.

A raw `fetch` in a component has no cache, no request de-duplication, no
built-in loading/error state, and no invalidation path when other code
changes the same data — every one of those has to be hand-rolled per
component, or silently skipped. Routing all server communication through a
React-Query-backed hook gives every component the same caching and
invalidation behavior for free, and keeps the fetch call, its URL, and its
response shape in one place instead of scattered across components.

## Consequences

- Existing direct-`fetch` call sites (`projects-combobox.tsx`,
  `model-tier-editor.tsx`, and others found by grepping client components for
  `fetch(`) are not yet compliant and should be migrated to a `use-*` hook as
  they are touched.
- A new client-side data need is met by adding or extending a hook in
  `src/hooks/`, not by adding a `fetch` call to the component.

## Migration (2026)

The following components' direct `fetch` calls were migrated into React-Query
hooks in `src/hooks/`:

- `projects-combobox.tsx` → `use-workspace-projects.ts`
- `model-tier-editor.tsx` → reuses existing `use-models.ts` (removed a
  duplicate inline fetcher)
- `wiki-mini-graph.tsx` → `use-wiki-graph.ts`
- `session-item.tsx` / `sessions-list-client.tsx` → `use-session-mutations.ts`
  (rename, delete)
- `client-session-component.tsx` → `use-session-controls.ts` (stop, compact)
- `element-picker.tsx` → `use-set-element-target.ts`

### Exception: `app-terminal.tsx`

`app-terminal.tsx` keeps its direct `fetch` calls. Its calls are not
request/response data fetches: they open and stream an SSE-framed terminal
session and send keystroke/resize control messages over it. There is no
response payload to cache, de-duplicate, or invalidate — React Query's value
proposition does not apply to a live control channel. This is a deliberate,
named exception to the rule above, not an oversight.

A full-repo sweep after this migration found further pre-existing
direct-`fetch` call sites outside the original scope (e.g. in
`session-project-picker.tsx`, `wiki-browser.tsx`, `review-editor-pane.tsx`,
`git-status-badge.tsx`, and others). These remain non-compliant and are
tracked for a separate pass.
