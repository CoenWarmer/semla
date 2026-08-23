create table public.sessions (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  title text,
  user_id uuid references auth.users(id) on delete cascade
);

alter table public.sessions enable row level security;

create policy "Users can read their own sessions"
  on public.sessions
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can create their own sessions"
  on public.sessions
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

create policy "Users can update their own sessions"
  on public.sessions
  for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Users can delete their own sessions"
  on public.sessions
  for delete
  to authenticated
  using ((select auth.uid()) = user_id);
