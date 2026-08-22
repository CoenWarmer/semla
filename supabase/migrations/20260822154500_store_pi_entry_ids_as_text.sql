alter table public.pi_sessions
  drop constraint pi_sessions_active_leaf_entry_id_fkey;

alter table public.pi_session_entries
  drop constraint pi_session_entries_parent_entry_id_fkey;

alter table public.pi_session_entries
  alter column id drop default,
  alter column id type text using id::text,
  alter column parent_entry_id type text using parent_entry_id::text;

alter table public.pi_sessions
  alter column active_leaf_entry_id type text using active_leaf_entry_id::text;

alter table public.pi_session_entries
  add constraint pi_session_entries_parent_entry_id_fkey
  foreign key (parent_entry_id)
  references public.pi_session_entries(id);

alter table public.pi_sessions
  add constraint pi_sessions_active_leaf_entry_id_fkey
  foreign key (active_leaf_entry_id)
  references public.pi_session_entries(id)
  on delete set null;
