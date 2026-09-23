-- User-chosen overrides for the app's core CSS color variables, one set for
-- light mode and one for dark mode. Stored as jsonb rather than one column
-- per variable because the set is a single unit read and written together by
-- the settings UI, and a new variable should not need a migration to expose.
alter table public.user_settings add column if not exists theme_colors jsonb;
