-- A requirement is an artifact too: the fourth kind, and the durable turn id
-- that is the only join between a requirement and the code it produced.
--
-- Three changes, each with a reason that outlives this migration:
--
--  1. kind gains 'spec'. A requirement the operator stated (an @spec-marked
--     turn, or a submitted capture_feature_spec form) is something the session
--     produced, and it shares its identity — session, turn, tool call, time —
--     with the diffs it caused. See src/lib/artifacts/artifact-types.ts.
--
--  2. project_path becomes nullable. A requirement is stated to the session,
--     not to one repository, and a session can be anchored to several. Naming
--     one would be a claim the operator never made, so it is null for a spec
--     and non-null for every other kind — which is enforced in TypeScript
--     (SpecArtifact.projectPath: null) and by the check constraint below.
--
--  3. turn_id records the durable prompt-turn id minted once per turn in
--     src/app/api/sessions/[id]/prompt/route.ts. Unlike round_id — which is
--     client-local and joins to nothing — this is written to disk in three
--     places (the review turn mark, SPEC.md, the artifact record) and is the
--     key "which requirement led to which outcome" is answered with. Nullable
--     because rows written before this migration have no such id, and because
--     a capture outside a prompt turn (a background continuation) genuinely
--     has none. Never invented.
--
-- NOT APPLIED, same as 20260910000000: written to keep the schema under
-- version control without running the Supabase CLI (no db push, no db reset,
-- no generate:db-types).
--
-- Convention: a new migration file, never an edit to 20260910000000. That
-- file is committed and another session's database may already have run it,
-- and session-artifacts-schema.test.ts pins its text by path — editing it
-- would silently change what that test asserts. See
-- 20260901120000_drop_sessions_project_path.sql for the same pattern against
-- 20260901000000_add_session_projects.sql.

-- The base migration names this constraint implicitly (`check (kind in
-- (...))` inside `create table`), so Postgres generates
-- session_artifacts_kind_check. That name is stable for a single unnamed
-- column check. `if exists` is used anyway: the one thing in this file that
-- cannot be verified without a database, and dropping nothing beats dropping
-- the wrong thing.
alter table public.session_artifacts
  drop constraint if exists session_artifacts_kind_check;

alter table public.session_artifacts
  add constraint session_artifacts_kind_check
  check (kind in ('diff', 'commit', 'pr', 'spec'));

alter table public.session_artifacts
  alter column project_path drop not null;

-- A spec has no project; every other kind must have one. The nullability
-- above is what makes a spec expressible; this is what keeps it from
-- spreading to a kind that should still require one.
alter table public.session_artifacts
  add constraint session_artifacts_project_path_required
  check (kind = 'spec' or project_path is not null);

alter table public.session_artifacts
  add column turn_id text;

-- "What else did this turn produce" — the join this whole migration is for.
create index session_artifacts_session_turn_idx
  on public.session_artifacts (session_id, turn_id)
  where turn_id is not null;
