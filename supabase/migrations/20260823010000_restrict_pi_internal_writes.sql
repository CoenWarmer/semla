-- pi_sessions, pi_session_entries, and workflow_runs are written exclusively
-- by server-side code using the service-role (admin) client, which bypasses
-- RLS. These tables only ever had SELECT policies, meaning `authenticated`
-- role had no explicit grant for insert/update/delete but also no explicit
-- deny — relying entirely on the absence of a policy to block writes. Add
-- restrictive `using (false)` policies as defense-in-depth so that even if a
-- future policy or grant change accidentally permits writes, these tables
-- remain read-only for the `authenticated` role.

create policy "Block direct writes to pi_sessions"
on public.pi_sessions
as restrictive
for insert
to authenticated
with check (false);

create policy "Block direct updates to pi_sessions"
on public.pi_sessions
as restrictive
for update
to authenticated
using (false);

create policy "Block direct deletes from pi_sessions"
on public.pi_sessions
as restrictive
for delete
to authenticated
using (false);

create policy "Block direct writes to pi_session_entries"
on public.pi_session_entries
as restrictive
for insert
to authenticated
with check (false);

create policy "Block direct updates to pi_session_entries"
on public.pi_session_entries
as restrictive
for update
to authenticated
using (false);

create policy "Block direct deletes from pi_session_entries"
on public.pi_session_entries
as restrictive
for delete
to authenticated
using (false);

create policy "Block direct writes to workflow_runs"
on public.workflow_runs
as restrictive
for insert
to authenticated
with check (false);

create policy "Block direct updates to workflow_runs"
on public.workflow_runs
as restrictive
for update
to authenticated
using (false);

create policy "Block direct deletes from workflow_runs"
on public.workflow_runs
as restrictive
for delete
to authenticated
using (false);
