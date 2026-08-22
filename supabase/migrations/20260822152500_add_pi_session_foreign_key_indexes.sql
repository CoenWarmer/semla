create index pi_session_entries_parent_entry_idx
  on public.pi_session_entries (parent_entry_id);

create index pi_sessions_active_leaf_entry_idx
  on public.pi_sessions (active_leaf_entry_id);

create index sessions_user_id_idx
  on public.sessions (user_id);
