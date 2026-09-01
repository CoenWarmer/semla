-- A session relates to zero, one, or many projects.
--
-- Supersedes sessions.project_path, which held exactly one. The column stays
-- for now as a mirror of the primary link while its readers move across; a
-- later migration drops it.
--
-- Disk is authoritative for this relation (see src/lib/pi/session-meta.ts).
-- This table is the mirror, written server-side with the service-role client,
-- so that the data survives independently of the machine's .semla-sessions
-- directory. A reader that disagrees with disk defers to disk.

create table public.session_projects (
  session_id uuid not null references public.sessions(id) on delete cascade,
  -- Workspace-relative, never absolute: the workspace root differs between the
  -- host (/Users/x/Dev) and the container (/workspace), and an absolute path
  -- recorded under one is meaningless under the other.
  project_path text not null,
  -- How the link came to exist. 'explicit' is a choice the user made and can
  -- undo; 'observed' is a record of the agent having written there, and is not
  -- removable. A project that is both stays 'explicit'.
  origin text not null check (origin in ('explicit', 'observed')),
  is_primary boolean not null default false,
  first_attached_at timestamptz not null default now(),
  last_touched_at timestamptz not null default now(),
  primary key (session_id, project_path)
);

-- At most one anchor per session, enforced rather than left to convention.
create unique index session_projects_one_primary
  on public.session_projects (session_id)
  where is_primary;

-- "Which sessions touched this project" — not asked for yet, but it is the
-- question a join table exists to answer and the index is free at this size.
create index session_projects_path_idx
  on public.session_projects (project_path);

alter table public.session_projects enable row level security;

create policy "Users can read project links for their sessions"
on public.session_projects
for select
to authenticated
using (
  exists (
    select 1
    from public.sessions
    where sessions.id = session_projects.session_id
      and sessions.user_id = (select auth.uid())
  )
);

-- Written exclusively by server-side code using the service-role client, which
-- bypasses RLS. Restrictive policies rather than relying on the absence of a
-- policy, matching 20260823010000_restrict_pi_internal_writes.sql.
create policy "Block direct writes to session_projects"
on public.session_projects
as restrictive
for insert
to authenticated
with check (false);

create policy "Block direct updates to session_projects"
on public.session_projects
as restrictive
for update
to authenticated
using (false);

create policy "Block direct deletes from session_projects"
on public.session_projects
as restrictive
for delete
to authenticated
using (false);

grant select on public.session_projects to authenticated;

-- Backfill the one project each existing session already had.
--
-- A project is a directory one level below the workspace root, so its
-- workspace-relative path is its basename — no need to know which root the row
-- was written under, which is what makes this safe to run on host and
-- container data alike. Trailing slashes are trimmed first so a path stored as
-- "/Users/x/Dev/semla/" does not reduce to the empty string.
--
-- first_attached_at takes the session's own creation time rather than now():
-- the link is as old as the session, and a provenance record that claims
-- otherwise is worse than no timestamp.
insert into public.session_projects (
  session_id,
  project_path,
  origin,
  is_primary,
  first_attached_at,
  last_touched_at
)
select
  s.id,
  regexp_replace(rtrim(s.project_path, '/'), '^.*/', ''),
  'explicit',
  true,
  s.created_at,
  s.created_at
from public.sessions s
where s.project_path is not null
  and rtrim(s.project_path, '/') <> ''
  and regexp_replace(rtrim(s.project_path, '/'), '^.*/', '') <> ''
on conflict (session_id, project_path) do nothing;
