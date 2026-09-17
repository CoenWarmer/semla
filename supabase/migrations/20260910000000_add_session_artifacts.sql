-- What a session produced, attributed to the tool call that produced it.
--
-- Disk is authoritative (see src/lib/pi/artifacts/artifact-store.ts and the
-- argument in session_projects's own migration for why disk leads and this
-- table mirrors). This table is written server-side with the service-role
-- client, so the record survives the machine's .semla-artifacts directory. A
-- reader that disagrees with disk defers to disk.
--
-- The payload is jsonb rather than three tables of columns. The three kinds
-- (diff, commit, pr) share their identity and nothing else, the kind-specific
-- shapes are defined once in TypeScript (src/lib/artifacts/artifact-types.ts),
-- and a second, drifting definition in DDL is the failure mode worth avoiding
-- here. The columns promoted out of the payload are exactly the ones queried:
-- session, kind, tool call, project, time.
--
-- NOT APPLIED as part of this work item. Written to satisfy the operator's
-- instruction to have the migration under version control without running
-- the Supabase CLI (no db push, no db reset, no generate:db-types).

create table public.session_artifacts (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions(id) on delete cascade,
  -- The deterministic disk key. Unique per session so a re-capture of the
  -- same tool call upserts instead of duplicating. See artifact-key.ts.
  artifact_key text not null,
  kind text not null check (kind in ('diff', 'commit', 'pr')),
  -- 'tool-call' means tool_call_id is a real pi id. 'turn' means the change
  -- could not be attributed to a call; tool_call_id is then null, never
  -- invented. See artifact-attribution.ts and ArtifactAttribution's docblock.
  attribution text not null check (attribution in ('tool-call', 'turn')),
  -- Pi's own id: text, not uuid, for the reason
  -- 20260822154500_store_pi_entry_ids_as_text.sql records.
  tool_call_id text,
  tool_name text,
  -- The client-local assistant round id. Advisory: it is regenerated every
  -- process and joins to nothing. Stored because it is free.
  round_id text,
  -- Workspace-relative, never absolute, for the reason session_projects gives.
  project_path text not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  constraint session_artifacts_key_unique unique (session_id, artifact_key)
);

-- "This session's artifacts, newest first" — the only read the UI makes.
create index session_artifacts_session_created_at_idx
  on public.session_artifacts (session_id, created_at desc);

-- Every foreign key gets an index; Postgres does not add one. See
-- 20260822152500_add_pi_session_foreign_key_indexes.sql.
create index session_artifacts_session_id_idx
  on public.session_artifacts (session_id);

-- "What did this tool call produce" — the question the whole table exists for.
create index session_artifacts_tool_call_idx
  on public.session_artifacts (tool_call_id)
  where tool_call_id is not null;

-- "What has been done to this project" across sessions.
create index session_artifacts_project_idx
  on public.session_artifacts (project_path);

alter table public.session_artifacts enable row level security;

create policy "Users can read artifacts for their sessions"
on public.session_artifacts
for select
to authenticated
using (
  exists (
    select 1
    from public.sessions
    where sessions.id = session_artifacts.session_id
      and sessions.user_id = (select auth.uid())
  )
);

-- Written exclusively by server-side code using the service-role client, which
-- bypasses RLS. Restrictive policies rather than relying on the absence of a
-- policy, matching 20260823010000_restrict_pi_internal_writes.sql.
create policy "Block direct writes to session_artifacts"
on public.session_artifacts
as restrictive
for insert
to authenticated
with check (false);

create policy "Block direct updates to session_artifacts"
on public.session_artifacts
as restrictive
for update
to authenticated
using (false);

create policy "Block direct deletes from session_artifacts"
on public.session_artifacts
as restrictive
for delete
to authenticated
using (false);

grant select on public.session_artifacts to authenticated;

-- No backfill: there is no prior source of artifacts to backfill from, and
-- inventing rows from git history would attribute them to no tool call.
