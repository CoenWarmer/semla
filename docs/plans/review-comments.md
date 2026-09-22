# Plan: agent comments in the Review panel's Monaco editor

**Goal:** let an agent attach an explanation — of what a range of code does,
or why the agent put it there — directly onto the working file shown in the
Review panel. The operator sees it in place, next to the code it is about,
without leaving the editor.

**Status:** designed, not started. Confirmed with the operator: fixed widget
kinds (not literal JSX), server-persisted until dismissed, anchored to a line
range.

---

## 1. What "any React component" means here

An agent's tool call carries structured arguments, never JSX source. So a
comment is one of a **fixed, closed set of kinds**, each carrying a typed
payload the corresponding component renders:

```ts
export type ReviewCommentBody =
  | { kind: "text"; text: string }
  | { kind: "markdown"; markdown: string }
  | { kind: "warning"; markdown: string }   // same renderer as markdown, distinct affordance/colour
  | { kind: "diff-note"; markdown: string; beforeSnippet?: string; afterSnippet?: string };
```

v1 ships `text` and `markdown` only — that covers "explain this function" and
"here's why I added this" without inventing a component registry nobody has
asked for yet. `warning` and `diff-note` are sketched so the type is not
closed off by accident, but are not built until a real case needs them. Adding
a kind later means: one more variant in this union, one more `case` in the
renderer switch (§4), one more line in the tool's schema description. No
registry, no plugin system — the closed set *is* the design, and the docblock
on the renderer should say so plainly, so nobody "generalizes" it into a
registry before a second kind actually exists.

**Rendering markdown.** `Streamdown` is already a dependency
(`markdown-paragraph.tsx`, `wiki-page-view.tsx`) — reuse it rather than adding
a second markdown pipeline.

---

## 2. Data model and lifecycle

**Anchoring.** A comment anchors to a line *range* in a specific file
(`project` + `path`), 1-based, inclusive — the same shape a hunk's changed-line
span already uses (`startLine`/`endLine` in `HunkBracketEntry`). Multiple
comments may exist per file; overlapping ranges are allowed and not
deduplicated — that's a rendering problem (§4), not a data problem.

**Lifecycle: persists until the operator dismisses it.** Not turn-scoped, not
auto-expired. This means it survives a reload, so it is server state, not
`useState` in the panel. Given `session_artifacts` already carries exactly
this shape — jsonb payload, one closed set of kinds, tied to a session and
optionally a tool call — a sibling table is the natural fit rather than
overloading that one (its `kind` check-constraint is `diff | commit | pr`,
and comments are not an "artifact" the agent produced from the git tree; they
are annotations *about* one).

```sql
create table public.review_comments (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  project_path text not null,          -- workspace-relative, per session_projects convention
  file_path text not null,             -- project-relative
  start_line integer not null,
  end_line integer not null,
  body jsonb not null,                 -- ReviewCommentBody, validated in TS before insert
  tool_call_id text,                   -- attribution; nullable, same reasoning as session_artifacts
  dismissed_at timestamptz,            -- null = live; set = hidden, kept for the record
  created_at timestamptz not null default now()
);

create index review_comments_session_file_idx
  on public.review_comments (session_id, project_path, file_path)
  where dismissed_at is null;
```

Soft-delete (`dismissed_at`) rather than hard delete: cheap, matches this
repo's general bias toward not throwing away what happened, and costs nothing
since the only query is "live comments for this file."

RLS mirrors `session_artifacts`: `select` for the owning user, all writes
blocked for `authenticated` and done server-side with the service-role
client. Dismiss is a `PATCH`/`POST` setting `dismissed_at`, done the same way.

---

## 3. The tool: extending `open_review`, not a new tool

**Decision.** Add an optional `comment` parameter to the existing `open_review`
tool (`src/lib/pi/extensions/open-review.ts`) rather than a separate
`add_review_comment` tool.

**Why.** The whole point of a comment is "look at this and here's why" — that
is exactly what `open_review` already does when given a `path`/`line`. A
second tool would force the agent to make two calls (open, then comment) for
what is one intent, and would duplicate all of `open_review`'s target
resolution and validation (project-link check, path containment) that a
comment needs identically. `open_review`'s own docblock already frames it as
"put a change you have just made in front of the operator" — a comment is the
same act with words attached.

**Schema addition:**

```ts
comment: Type.Optional(Type.Object({
  kind: Type.Union([Type.Literal("text"), Type.Literal("markdown")]),
  text: Type.String({ description: "The explanation. Markdown is rendered when kind is \"markdown\"." }),
  endLine: Type.Optional(Type.Integer({ minimum: 1 })), // defaults to `line` when omitted — single-line comment
}, { additionalProperties: false })),
```

`comment` requires `path` and `line` (`startLine`) to already be present in
the same call — reuse the existing "no path" validation branch rather than a
new one. `endLine < line` is a validation error, same class as the existing
"does not resolve inside project" throws.

**Execution.** After resolving `target` exactly as today, if `comment` is
present: insert a `review_comments` row (service-role client, same module
`session-artifacts` writes through) keyed by the resolved `project`/`path`,
then include the comment in `details` alongside `target` so the *live* SSE
path (§5) doesn't have to round-trip through the database before the operator
sees it.

```ts
export type OpenReviewDetails = {
  target: OpenReviewTarget | null;
  comment?: { id: string; startLine: number; endLine: number; body: ReviewCommentBody };
  type: "open-review";
};
```

---

## 4. Rendering in Monaco

**Widget mechanism: `IContentWidget`, following `AccessLabelWidgets`
exactly.** Not a glyph-margin widget (`HunkBracketWidgets`) — a comment's
content is prose/markdown that needs real width, not a narrow gutter lane.
`ContentWidgetPositionPreference.ABOVE`, `allowEditorOverflow: true` for a
comment anchored at line 1, `suppressMouseDown` so the widget doesn't steal
the text cursor. One React root per widget (`createRoot`, deferred `unmount`
in `setTimeout`), rebuilt wholesale on every `set()` — same reasoning as the
two existing widget classes: a comment's key is its anchor position, not a
stable identity that would benefit from being diffed in place.

```
src/components/review/review-comment-widgets.tsx   — ReviewCommentWidgets class, mirrors review-access-label-widgets.tsx
src/components/review/review-comment-body.tsx        — the ReviewCommentBody -> JSX switch (text | markdown)
```

**Multi-line span, not single-line.** Unlike `AccessLabelChip`, a comment
covers a range. Draw the widget above `startLine` (same `ABOVE`/`BELOW`
fallback as access labels for the line-1 case), but give it a left-edge
vertical bracket spanning to `endLine`, reusing `hunkBracketLineCount`'s
geometry idea from `review-hunk-bracket-geometry.ts` — that module already
solves "how tall a marker should be when the viewport clips the range," and a
comment has the identical clipping problem `HunkBracketWidgets.updateForScroll`
solves. Do not re-derive that math; import and reuse it, generalizing its
input type if it's currently `HunkBracketEntry`-specific.

**Dismiss affordance.** A small "×" in the widget's own header, calling a
`PATCH` to set `dismissed_at`, then removing that entry from local state so
the panel doesn't wait for a refetch. `suppressMouseDown` still applies to the
body; the dismiss button needs its own `stopPropagation`, same pattern
`HunkBracket`'s button already uses.

**Overlap with existing widgets.** A comment's anchor line can coincide with
an access-label chip's or a hunk bracket's. All three are independent content
widgets/glyph-margin widgets Monaco stacks by z-order — no new conflict is
introduced as long as the comment widget's own `zIndex` (if any is needed) is
picked deliberately, the way `HunkBracketWidgets` picks `zIndex: 100` for its
lane. Verify visually in phase 3 rather than assuming.

---

## 5. Wiring: tool → browser

Follow the `open_review`/`code_map` path in `session-event-router.ts`
exactly — this is a solved problem in this codebase, not a new one:

1. `session-event-router.ts`'s `onToolEnd`, in the existing
   `if (event.toolName === "open_review")` block: also read `comment` off
   `details` (extend `readOpenReviewResult` in `open-review-result.ts` to
   validate and return it) and `emit({ comment, target, type: "open-review" })`.
2. `turn-stream-reducer.ts`: extend the `"open-review"` case to also carry a
   `comment` field into `openReviewRequest` (or a sibling
   `openReviewCommentRequest` if bundling gets awkward — decide once §5 is
   actually written, not here).
3. `client-session-component.tsx`: the existing effect that reacts to
   `openReviewRequestNonce` also fetches/prepends the new comment into
   `ReviewPanel`'s comment state for the target file.
4. `ReviewPanel` → `ReviewEditorPane`: a `comments: ReviewComment[]` prop,
   filtered to the currently open file (same filtering shape `access` already
   gets — see the `request.selection?.path === selection.path` guard around
   line 855 of `review-panel.tsx`).
5. On mount/file-switch, `ReviewEditorPane` also does one `GET` for a file's
   live (non-dismissed) comments — so a comment from three turns ago still
   shows up on reopening the panel, not only ones created in the live SSE
   stream this session.

**New route:** `GET /api/sessions/[id]/review/comments?project=&path=` (list
live comments for a file) and `PATCH /api/sessions/[id]/review/comments/[commentId]`
(dismiss), both following the review routes' existing allowlist convention —
project matched against session links, never trusted from the caller.

---

## 6. Phases

**Phase 0 — Data & schema.** `review_comments` migration (not applied — this
repo's convention per `20260910000000_add_session_artifacts.sql`'s own
docblock is to write it and let the operator run the CLI), `ReviewCommentBody`
type in `review-types.ts`, insert/list/dismiss helpers alongside
`review-service.ts`.

**Phase 1 — Tool.** Extend `open_review`'s schema and `execute`, extend
`OpenReviewDetails`/`readOpenReviewResult`. Unit tests: comment requires
`path`+`line`, `endLine < line` rejected, insert happens only after target
resolution succeeds.

**Phase 2 — Routes.** `GET`/`PATCH` comments routes, with the same
project-containment tests every other review route has.

**Phase 3 — Widget rendering.** `ReviewCommentWidgets`, `ReviewCommentBody`
renderer (text + markdown only), wired into `ReviewEditorPane` behind a static
prop first (no live wiring yet) — mirrors how `review-panel.md`'s own phase 0
de-risked Monaco before building the rest.

**Phase 4 — Live wiring.** §5 end to end: tool call → SSE → reducer → panel →
widget, plus the on-open-file `GET` for previously-created comments.

**Phase 5 — Dismiss.** The "×" affordance, `PATCH`, optimistic local removal.

**Phase 6 — Polish.** Overlap/z-order check against access labels and hunk
brackets in a real multi-signal file; long markdown bodies (scroll or clamp
inside the widget, since Monaco doesn't reflow layout for a content widget's
height the way a view zone would); empty/error states on the list fetch.

---

## 7. Deferred, deliberately

- **Component kinds beyond text/markdown.** The union in §1 is open-ended on
  paper; nothing beyond `text`/`markdown` is built until a real request for
  it exists.
- **Threaded replies / operator responses to a comment.** This plan is
  one-directional (agent → operator). A reply model is a different feature.
- **Comment-triggered re-prompting** ("fix what this comment flags"). Same
  shape of deferral `review-panel.md` §12 already made for "send a review
  back to the agent" — a comment is not a reason to blur that boundary again.
- **Auto-anchoring migration when the underlying lines move.** A comment's
  `startLine`/`endLine` are a snapshot. If the operator edits the file
  afterward, the anchor goes stale the same way hunk decorations go stale
  per `review-panel.md` §5 ("Surviving edits") — accepted there for the same
  reason: honest and cheap beats clever and wrong.

---

## 8. Open questions for whoever picks this up

- Should `dismissed_at` comments be visible anywhere (e.g. a "past comments"
  drawer), or truly gone from the UI once dismissed? This plan assumes gone.
- Does a comment on a *hunk* (rather than an arbitrary range) need index-aware
  addressing like `review-hunk-match.ts` gives hunks, so a comment survives
  staging the way a hunk bracket's action does? Deferred here because nothing
  in the confirmed scope ties a comment to a hunk specifically — it anchors to
  raw file lines, not to a stage/unstage-addressable hunk index.
