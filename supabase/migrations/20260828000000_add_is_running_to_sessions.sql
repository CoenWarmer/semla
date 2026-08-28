ALTER TABLE sessions ADD COLUMN is_running boolean NOT NULL DEFAULT false;

-- Enable Realtime for sessions table so the sidebar spinner clears live
-- (no-op if sessions is already a member of the publication)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'sessions'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE sessions;
  END IF;
END
$$;
