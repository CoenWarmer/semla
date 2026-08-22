create table public.user_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  default_model_provider text,
  default_model_id text,
  updated_at timestamptz not null default now(),
  check (
    (default_model_provider is null and default_model_id is null)
    or (default_model_provider is not null and default_model_id is not null)
  )
);

alter table public.user_settings enable row level security;

create policy "Users can read their settings"
on public.user_settings
for select
to authenticated
using ((select auth.uid()) = user_id);

create policy "Users can create their settings"
on public.user_settings
for insert
to authenticated
with check ((select auth.uid()) = user_id);

create policy "Users can update their settings"
on public.user_settings
for update
to authenticated
using ((select auth.uid()) = user_id)
with check ((select auth.uid()) = user_id);

grant select, insert, update on public.user_settings to authenticated;
