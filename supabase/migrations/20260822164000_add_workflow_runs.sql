create table public.workflow_runs (
  id uuid primary key default gen_random_uuid(),
  semla_session_id uuid not null references public.sessions(id) on delete cascade,
  run_id text not null unique,
  mode text not null check (mode in ('foreground', 'background')),
  status text not null default 'running'
    check (status in ('running', 'completed', 'failed', 'paused', 'stopped', 'interrupted')),
  snapshot jsonb not null default '{}'::jsonb,
  result jsonb,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index workflow_runs_session_updated_at_idx
  on public.workflow_runs (semla_session_id, updated_at desc);

alter table public.workflow_runs enable row level security;

create policy "Users can read workflow runs for their sessions"
on public.workflow_runs
for select
to authenticated
using (
  exists (
    select 1
    from public.sessions
    where sessions.id = workflow_runs.semla_session_id
      and sessions.user_id = (select auth.uid())
  )
);

grant select on public.workflow_runs to authenticated;
