-- In local mode (AUTH_REQUIRED = false, bound to loopback) the Next.js
-- server calls Supabase with the anon key and no JWT, so auth.uid() is null
-- and the existing INSERT policy (to authenticated) blocks all session
-- creation. This policy allows server-side inserts with any non-null user_id
-- so the disk-first session creation can mirror to Supabase.
--
-- Safe for Semla because it is a single-user tool: when SEMLA_BIND_HOST
-- exposes the server (AUTH_REQUIRED = true), the anon client is not used
-- for session operations — requests are authenticated at the proxy layer.
create policy "Server can create sessions without user auth"
  on public.sessions
  for insert
  to anon
  with check (user_id is not null);
