ALTER TABLE sessions ADD COLUMN is_running boolean NOT NULL DEFAULT false;

-- Enable Realtime for sessions table so the sidebar spinner clears live
ALTER PUBLICATION supabase_realtime ADD TABLE sessions;
