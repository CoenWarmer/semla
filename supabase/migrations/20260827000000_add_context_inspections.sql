create table public.context_inspections (
  id uuid primary key default gen_random_uuid(),
  semla_session_id uuid not null references public.sessions(id) on delete cascade,
  result jsonb not null,
  created_at timestamptz not null default now()
);

create index context_inspections_session_created_at_idx
  on public.context_inspections (semla_session_id, created_at desc);

alter table public.context_inspections enable row level security;

create policy "Users can read context inspections for their sessions"
on public.context_inspections
for select
to authenticated
using (
  exists (
    select 1
    from public.sessions
    where sessions.id = context_inspections.semla_session_id
      and sessions.user_id = (select auth.uid())
  )
);

create policy "Users can insert context inspections for their sessions"
on public.context_inspections
for insert
to authenticated
with check (
  exists (
    select 1
    from public.sessions
    where sessions.id = context_inspections.semla_session_id
      and sessions.user_id = (select auth.uid())
  )
);

grant select, insert on public.context_inspections to authenticated;
