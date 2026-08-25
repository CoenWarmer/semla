-- The UPDATE and DELETE policies for sessions were defined in the original
-- migration but were never applied to the database. Without them, RLS blocks
-- all updates and deletes silently (no error, 0 rows affected).

create policy if not exists "Users can update their own sessions"
  on public.sessions
  for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy if not exists "Users can delete their own sessions"
  on public.sessions
  for delete
  to authenticated
  using ((select auth.uid()) = user_id);
