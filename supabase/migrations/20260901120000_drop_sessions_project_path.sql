-- Retire sessions.project_path.
--
-- It held the single project a session could have. That relation now lives in
-- session_projects (20260901000000), which has carried every row since that
-- migration's backfill, and on disk in SessionMeta.projects, which
-- scripts/backfill-session-projects.mjs filled in for the records that only
-- ever had the old field.
--
-- Nothing reads the column any more. The last two readers were
-- resolveSessionPromptContext, which now takes links, and a fallback in
-- sessionProjects() that rebuilt a link from it — both removed in the same
-- change as this file. Apply it after deploying that code, not before: a
-- running instance that still selects the column would fail on every read.
--
-- Losing it costs nothing that is not stored twice elsewhere, but it is worth
-- being clear that this is one-way. Recovering it would mean reconstructing
-- absolute paths from relative ones and a workspace root, which is precisely
-- the coupling to a single machine that moving to session_projects removed.

alter table public.sessions drop column if exists project_path;
