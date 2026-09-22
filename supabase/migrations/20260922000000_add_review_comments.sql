-- Agent-authored explanations anchored to a line range in a reviewed file.
--
-- Sibling to session_artifacts, not a fourth `kind` on it: an artifact is
-- something the session *produced* from the git tree (a diff, a commit, a
-- pr); a comment is an annotation *about* code, produced by the open_review
-- tool rather than by observing a mutating tool call, and it has its own
-- lifecycle (dismissed_at) that none of session_artifacts' kinds need. See
-- docs/plans/review-comments.md §2 for the reasoning.
--
-- The payload is jsonb, one closed union (ReviewCommentBody in
-- review-types.ts) validated in TypeScript before insert — same choice
-- session_artifacts makes for its own payload, and for the same reason: one
-- definition of the shape, not a drifting second one in DDL.
--
-- NOT APPLIED, same convention as 20260910000000_add_session_artifacts.sql
-- and 20260911000000_add_spec_artifacts.sql: written to keep the schema
-- under version control without running the Supabase CLI (no db push, no db
-- reset, no generate:db-types). database.types.ts is hand-edited to match,
-- pinned by review-comments-schema.test.ts the way session-artifacts-schema.test.ts
-- pins session_artifacts.

create table public.review_comments (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  -- Workspace-relative, never absolute — the session_projects convention.
  project_path text not null,
  -- Project-relative, matching every other review route's path shape.
  file_path text not null,
  start_line integer not null,
  end_line integer not null,
  -- ReviewCommentBody, validated in TypeScript. See review-comment-types.ts.
  body jsonb not null,
  -- Attribution: the open_review call that created this comment, when it
  -- carries one. Nullable for the same reason session_artifacts.tool_call_id
  -- is — a comment could in principle be created by something other than a
  -- live tool call in the future, and nothing here should force one.
  tool_call_id text,
  -- Soft-delete. Null means live; a timestamp hides it from the panel while
  -- keeping the record — cheaper than a hard delete and matches this repo's
  -- general bias toward not throwing away what happened.
  dismissed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint review_comments_line_range check (end_line >= start_line)
);

-- "This file's live comments" — the only read the editor pane makes.
create index review_comments_session_file_idx
  on public.review_comments (session_id, project_path, file_path)
  where dismissed_at is null;

-- Every foreign key gets an index; Postgres does not add one. See
-- 20260822152500_add_pi_session_foreign_key_indexes.sql.
create index review_comments_session_id_idx
  on public.review_comments (session_id);

alter table public.review_comments enable row level security;

create policy "Users can read comments for their sessions"
on public.review_comments
for select
to authenticated
using (
  exists (
    select 1
    from public.sessions
    where sessions.id = review_comments.session_id
      and sessions.user_id = (select auth.uid())
  )
);

-- Written exclusively by server-side code using the service-role client,
-- which bypasses RLS. Restrictive policies rather than relying on the
-- absence of a policy, matching 20260823010000_restrict_pi_internal_writes.sql
-- and session_artifacts' own policies.
create policy "Block direct writes to review_comments"
on public.review_comments
as restrictive
for insert
to authenticated
with check (false);

create policy "Block direct updates to review_comments"
on public.review_comments
as restrictive
for update
to authenticated
using (false);

create policy "Block direct deletes from review_comments"
on public.review_comments
as restrictive
for delete
to authenticated
using (false);

grant select on public.review_comments to authenticated;

-- No backfill: there is no prior source of comments to backfill from.
