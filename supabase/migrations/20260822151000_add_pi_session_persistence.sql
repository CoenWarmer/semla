create table public.pi_sessions (
  id uuid primary key default gen_random_uuid(),
  semla_session_id uuid not null unique references public.sessions(id) on delete cascade,
  workspace_root text not null default '/workspace'
    check (workspace_root = '/workspace'),
  model_provider text,
  model_id text,
  active_leaf_entry_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.pi_session_entries (
  id text primary key,
  pi_session_id uuid not null references public.pi_sessions(id) on delete cascade,
  parent_entry_id text references public.pi_session_entries(id),
  event_type text not null,
  payload jsonb not null,
  created_at timestamptz not null default now()
);

alter table public.pi_sessions
  add constraint pi_sessions_active_leaf_entry_id_fkey
  foreign key (active_leaf_entry_id)
  references public.pi_session_entries(id)
  on delete set null;

create index pi_session_entries_session_created_at_idx
  on public.pi_session_entries (pi_session_id, created_at);

create index pi_session_entries_session_parent_idx
  on public.pi_session_entries (pi_session_id, parent_entry_id);

create index pi_session_entries_parent_entry_idx
  on public.pi_session_entries (parent_entry_id);

create index pi_sessions_active_leaf_entry_idx
  on public.pi_sessions (active_leaf_entry_id);

create index sessions_user_id_idx
  on public.sessions (user_id);

alter table public.pi_sessions enable row level security;
alter table public.pi_session_entries enable row level security;

create policy "Users can read Pi state for their sessions"
on public.pi_sessions
for select
to authenticated
using (
  exists (
    select 1
    from public.sessions
    where sessions.id = pi_sessions.semla_session_id
      and sessions.user_id = (select auth.uid())
  )
);

create policy "Users can read Pi entries for their sessions"
on public.pi_session_entries
for select
to authenticated
using (
  exists (
    select 1
    from public.pi_sessions
    join public.sessions on sessions.id = pi_sessions.semla_session_id
    where pi_sessions.id = pi_session_entries.pi_session_id
      and sessions.user_id = (select auth.uid())
  )
);

grant select on public.pi_sessions, public.pi_session_entries to authenticated;
