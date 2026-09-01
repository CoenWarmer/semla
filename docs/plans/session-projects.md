# Plan: a session relates to zero, one, or many projects

**Goal:** replace the single `sessions.project_path` with an explicit relation
between a session and the projects it works in. A session may have none, one, or
several. Projects can be attached by the user at or after creation, and are
attached automatically when the agent writes to one. The relation is stored on
disk and in Postgres, disk authoritative.

**Status:** designed, not started. Written 2026-09-01.

---

## 1. What is actually true today

The single most important fact about this change is that **it does not widen
what the agent can do.**

`runPiPrompt` opens the session and the agent at the workspace root, not at the
project:

- `SessionManager.open(sessionFile, PI_SESSION_DIR, PI_WORKSPACE_ROOT)` — `src/lib/pi/session-service.ts:451`
- `new DefaultResourceLoader({ cwd: PI_WORKSPACE_ROOT, ... })` — `src/lib/pi/session-service.ts:486`
- `createAgentSession({ cwd: PI_WORKSPACE_ROOT, ... })` — `src/lib/pi/session-service.ts:499`

`PI_WORKSPACE_ROOT` is the directory holding *every* repository on the machine.
The agent has always been able to read and write across all of them. A session's
`project_path` bounds nothing; it is metadata that five consumers read.

So this is a change to the *record*, catching it up with what the runtime
already permits. There is no "which project is the agent in" question to answer,
because there isn't one, and introducing one would be a different feature.

### Who reads `project_path` now

| Consumer | Use |
|---|---|
| `src/app/api/sessions/[id]/git/route.ts:27,57` | branch + divergence panel, checkout, merge |
| `src/lib/pi/prompts.ts:98-105` | "The active project for this session is X" in the system prompt |
| `src/lib/pi/session-service.ts:474` | `setSessionRepo()` — wiki page attribution |
| `src/lib/pi/file-browser.ts:38-48` | `basePath` — where the file tree opens |
| `src/app/api/sessions/route.ts:20-38` | set at creation from a project card |

`sessionProjectPath()` in `src/lib/pi/session-project.ts` — extracted out of the
git route in the in-flight file-browser work — is already the single chokepoint
all of these want to go through. That extraction is what makes this change
tractable, and it should land before this does.

---

## 2. The model

`project_path` conflates two things that are not the same:

- **Anchor** — where the UI points. The file tree root, the branch badge, the
  session title. Editorial, user-owned, at most one per session.
- **Provenance** — what the session has actually written to. Behavioural,
  agent-owned, zero or more.

Collapsing them into a flat list leaves the git panel with no answer to "which
branch" and the wiki with no answer to "which repo slug", and gives a repo the
agent touched once equal billing with the repo the session exists to change.

So a link carries two orthogonal fields:

- `origin: 'explicit' | 'observed'` — how the link came to exist. Sticky: a
  project the user picked *and* the agent wrote to stays `explicit`.
- `is_primary: boolean` — the anchor. At most one per session, enforced by a
  partial unique index rather than by convention.

They are orthogonal on purpose. An unanchored session that reveals its subject
by writing to a repo should be able to promote that observed link to primary.

### Settled decisions

1. **`is_primary` is an explicit, re-assignable flag**, not "the first explicit
   link". A session mis-titled at creation must be re-anchorable, and an
   observed link must be promotable.
2. **Observed links cannot be detached.** Only `explicit` links get a remove
   affordance. The observed set is a *provenance log, not a configuration
   list* — a log you can edit is not a log, and traceability is the point of
   this app. Consequence for the UI: see §9.
3. **The set enforces nothing.** No warning, no blocking on writes outside the
   attached projects. It is purely a lens. Enforcement is a separate feature
   with its own safety argument, and it would directly conflict with
   auto-attach: the first write to a new repo would be refused rather than
   recorded.
4. **Bash writes are not detected.** See §6.3.

---

## 3. Project identity: workspace-relative

Today the identity is an absolute path. Change it to the path relative to the
workspace root (`semla`, `nested/thing`). Three reasons:

1. `PI_WORKSPACE_ROOT` is `/workspace` in the container and `process.cwd()` on
   the host. There is already a migration named
   `20260822151106_allow_host_workspace_roots.sql`; absolute paths have caused
   trouble before.
2. The file-browser work established workspace-relative paths as *the*
   coordinate system for the file API, with the rationale written into
   `src/lib/pi/file-browser.ts`. A second coordinate system for the same
   directories is the thing that module exists to avoid.
3. `projectPrefix()` already decides a project outside the workspace root is
   unaddressable and reports it absent. The codebase has taken this position.

Note that `repoSlugFromProjectPath()`
(`src/lib/pi/extensions/wiki-frontmatter.ts:33`) is `basename()`, so it collides
for nested repos. The relative path does not. The slug stays derived, for wiki
frontmatter only.

### Migration of existing values

Existing `sessions.project_path` rows hold absolute paths. Convert with
`relative(workspace_root, project_path)` at migration time; skip rows that fall
outside the root (they were already unaddressable). The reader tolerates both
shapes for one release: a value starting with `/` is absolutised-then-relativised
on read.

---

## 4. Disk shape

`SessionMeta` (`src/lib/pi/session-meta.ts`) grows one field:

```ts
export interface ProjectLink {
  /** Workspace-relative path. The identity. */
  path: string;
  origin: "explicit" | "observed";
  isPrimary: boolean;
  firstAttachedAt: string;
  lastTouchedAt: string;
}

export interface SessionMeta {
  // ...existing fields
  projects: ProjectLink[];
}
```

`readSessionMeta` already spreads a parsed record over `blank(id)`, so a file
written before this field existed reads as an empty list with no versioning and
no backfill pass.

Keep `projectPath` on the record for one release, written as a mirror of the
primary link, so `session-prompt-context`, the git route and the wiki stamp do
not all have to change in the same commit.

**Do not add a reverse index.** `session-meta.ts` argues against exactly that:

> One file per session rather than an index: an index is a second thing to keep
> in sync, and the failure mode — a session that exists but is not listed — is
> exactly what this is meant to prevent.

"Which sessions touched project X" is a scan of `listSessionMeta()`, which the
sidebar already performs. Postgres answers it properly if it ever needs to.

---

## 5. Postgres shape

```sql
create table public.session_projects (
  session_id uuid not null references public.sessions(id) on delete cascade,
  project_path text not null,
  origin text not null check (origin in ('explicit', 'observed')),
  is_primary boolean not null default false,
  first_attached_at timestamptz not null default now(),
  last_touched_at timestamptz not null default now(),
  primary key (session_id, project_path)
);

create unique index session_projects_one_primary
  on public.session_projects (session_id)
  where is_primary;

create index session_projects_path_idx
  on public.session_projects (project_path);
```

RLS follows `20260822164000_add_workflow_runs.sql`: a SELECT policy via
`exists (select 1 from public.sessions where sessions.id = ... and user_id = (select auth.uid()))`,
`grant select ... to authenticated`, plus the restrictive `using (false)`
insert/update/delete policies established in
`20260823010000_restrict_pi_internal_writes.sql`.

All writes go through `createAdminClient()` behind API routes that call
`requireSessionOwner()` (`src/lib/session-auth.ts`). That keeps explicit and
observed attachment on one code path, and matches how every other server-owned
table in this schema is written.

`sessions.project_path` stays for one release as the mirror of the primary, then
a follow-up migration drops it.

The table is also the natural future home for per-project branch state, since
checkout and merge in `git/route.ts` are already per-path. Not in this change.

---

## 6. Attaching

### 6.1 Explicit

- **At creation** — `POST /api/sessions` already takes `projectPath` from the
  project card (`src/components/projects-grid.tsx:52`,
  `src/components/projects-combobox.tsx:46`). It creates the first link as
  `origin: 'explicit'`, `is_primary: true`.
- **After creation** — a new route, `POST /api/sessions/[id]/projects`, taking a
  workspace-relative path validated against `getWorkspaceProjects()`. Creates an
  `explicit` link, non-primary unless asked.
- **Re-anchor** — `PATCH .../projects/[path]` with `{ isPrimary: true }`, which
  clears the previous primary in the same transaction.
- **Remove** — `DELETE .../projects/[path]`, refused with 409 when the link is
  `observed`.

### 6.2 Observed

The seam already exists. `session-service.ts` handles `tool_execution_start`
(which carries `args`) and `tool_execution_end` (which carries `result` and
`isError` but *not* `args`) in the same switch, correlated by `toolCallId`.

So: capture the path on start into a per-turn map keyed by `toolCallId`; on end,
if `!isError`, resolve it to a project and record it. Failed edits do not
attach.

`edit` and `write` both take a single `path` field, relative or absolute —
confirmed against the typebox schemas in
`node_modules/@earendil-works/pi-coding-agent/dist/core/tools/{edit,write}.d.ts`.
`read`, `grep`, `find` and `ls` are deliberately ignored: the user's requirement
is "changes files", and attaching on reads would also make the file browser
attach a project every time someone opens a file in it.

Resolution, in a new `src/lib/pi/project-of-path.ts`:

1. Absolutise against `PI_WORKSPACE_ROOT` (the agent's cwd).
2. Reject anything that escapes the root.
3. Walk up to the nearest ancestor containing `.git`, stopping at the root.
4. Return it workspace-relative. Cache the directory→project answer per process;
   this runs on every write tool call.

Nested repos resolve to the innermost one, which is the correct answer for a
submodule.

**Batching.** Accumulate touched projects in memory for the turn and flush only
when a genuinely new one appears. Most edits hit an already-attached project, so
this is roughly one write per new project rather than one per edit.
`last_touched_at` is updated at end of turn, once.

### 6.3 The bash gap, stated plainly

`git commit`, `sed -i`, `mv`, a build that writes generated output — none of it
surfaces a typed path, and a shell parser that guesses is wrong in ways nobody
can predict. v1 attaches from `edit` and `write` only, and the module docblock
says so, the way `file-walk.ts` reports its budget rather than enforcing it
silently. A missing link is recoverable: the user attaches it by hand.

If accuracy matters later, the sound technique is snapshotting
`git status --porcelain` for *already-known* projects at turn start and diffing
at turn end. That catches bash writes but cannot discover new projects, so it is
a refinement, not a substitute. Do not ship path extraction from command
strings.

---

## 7. Hazard: `writeSessionMeta` is read-modify-write

Its docstring says this is safe:

> Read-modify-write is safe enough here: a session is written by the one process
> that owns it, and the fields are last-writer-wins by nature.

**Auto-attach breaks that premise.** Appending to an array is not
last-writer-wins. A concurrent `isRunning` or `title` write during a turn will
read a stale record and drop a link, silently, and nobody will notice for weeks.

Fix: a per-session-id promise chain inside `session-meta.ts`, with *every*
writer routed through it — not just the attach path. Small, but it must land in
the same commit as the array, not after it. `session-meta.test.ts` gets a case
that interleaves two concurrent patches and asserts neither is lost.

---

## 8. Consumers

| Consumer | Change |
|---|---|
| `session-project.ts` | `sessionProjectPath()` → `sessionProjects()` returning `{ primary, links }`. Everything else follows from this one function. |
| `git/route.ts` | Badge shows the primary. The panel lists each attached project with its own branch; `readGitStatus` is already per-path. Checkout/merge take an explicit project. |
| `file-browser.ts` | `basePath` = primary. |
| `file-search.ts` | `inProject` becomes three bands — primary, other attached, workspace — which the existing coarse-band scoring absorbs without restructuring. |
| `prompts.ts` | "The active project is X" → the primary plus the attached list. |
| wiki stamp | Primary only. See below. |
| `sessions/route.ts` | Creates the first link. |

### The wiki is the deepest impact

`setSessionRepo(piRuntimeSessionId, repoSlugFromProjectPath(projectPath))`
(`session-service.ts:474`) binds one repo slug per pi runtime session, and that
drives how every captured wiki page is attributed. The wiki's *content* model
already handles multi-repo — `prompts.ts` teaches `repo: [semla, ecs]` as a YAML
list — but the stamp is singular.

v1 stamps with the primary and does nothing cleverer. Correct multi-repo
attribution means deciding attribution per page or per write, which is its own
piece of work with its own failure modes. Out of scope here, and noted in the
docblock so the limitation is traceable rather than surprising.

---

## 9. UI

### 9.1 The two link kinds are not one list

Decision 2 has a direct consequence: explicit and observed links **must not
render as one uniform list** with a delete button on some rows and not others.
A non-removable row in something that looks like a settings list reads as a bug.

They are two things and should look like two things:

- **Anchor** — one row, prominent, with the branch badge and a control to change
  it. This is configuration.
- **Touched in this session** — a quieter list underneath, with
  `first_attached_at`, no delete affordance, and a "make this the anchor"
  action. This is history. Explicit non-primary links appear here too, with a
  remove control, since they *are* configuration.

Placement: the Files sheet already moved to the left as navigation, and the
project set is the same kind of thing. Most likely a section at the top of that
sheet rather than a new surface.

### 9.2 Sidebar: a badge per related project

Every session row in the sidebar carries one badge per project it relates to.

This does **not** get a new component. `GitStatusBadge`
(`src/components/git-status-badge.tsx`) already is the branch indicator, already
knows how to address a project, and is already reused by the app header and the
project cards. It gains two props:

```ts
/** Render the project's name. Off by default — the header has no room. */
showProjectName?: boolean;
/** Render the branch ref, the ahead/behind counts, and the actions popover. */
showBranchStatus?: boolean; // default true
```

| Surface | Props | Result |
|---|---|---|
| App header (`header-actions.tsx`) | defaults | unchanged: branch, counts, popover |
| Project cards (`projects-grid.tsx`) | defaults | unchanged: the card title is already the name |
| Sidebar row (`session-item.tsx`) | `showProjectName`, `showBranchStatus={false}` | a compact project chip |

Three consequences follow, and each is the reason the reuse works rather than
an obstacle to it.

**Use `{ kind: "project", path }` for sidebar badges, never `{ kind: "session" }`.**
The session variant fetches `/api/sessions/[id]/git`, which is one React Query
per session, each polling on its own 30s interval and each able to trigger a
server-side `git fetch`. A sidebar of thirty sessions would be thirty polling
queries. The project variant shares a single workspace-wide query across every
badge on screen and never fetches from the poll — `use-git-status.ts` says so
directly:

> Every card shares one workspace query, so a page of forty projects makes one
> request rather than forty.

That is exactly the property a list of badges needs, so **no new `GitTarget`
variant is required**. Note that `/api/projects/git` keys its record by the
*absolute* path (`workspace-git.ts:63`, from `getWorkspaceProjects()`), so the
sidebar resolves each link's workspace-relative path against the root before
passing it. Relative stays the stored identity; absolute is the wire format this
one endpoint already speaks.

**`showBranchStatus: false` must also suppress the popover.** Opening it fires
`refresh.mutate()`, which POSTs `action: "refresh"` and performs a real network
`git fetch`. The trigger opens *on hover* with a 250ms delay, so running the
pointer down a session list would fire a fetch per project passed over.
`GIT_FETCH_INTERVAL_MS` throttles per repository at 60s server-side, so this is
a waste rather than a hazard — but a chip that is deliberately not showing
branch state should not be offering "merge" and "check out" either. When
`showBranchStatus` is false the badge renders a plain, non-interactive chip.
*This is a judgement call, not something decided; a third prop could separate
the popover from the counts if that turns out to be wanted.*

**`if (!label) return null` has to become conditional.** Today the badge renders
nothing when git has nothing to say, and the docblock defends that: "An empty
slot reads better here than a placeholder next to the model picker." That
remains right for the header, but a sidebar chip should still name its project
when the repo has no commits or git is unavailable — the relation is a fact
independent of git state. The guard becomes: return null only when there is
neither a name to show nor a label to show.

### 9.3 Getting the data there — free, as it happens

`/api/sessions/status` is built from `listSessionMeta()`: disk only, no
database, no per-session query. The links live on that same record, so
`projects` rides along at zero cost and the route keeps the property its
docblock is proud of — the sidebar works when Postgres does not.

Three types grow the field: `SessionStatus` (`src/lib/session-status.ts`),
`SessionRow` (`sessions-list-client.tsx`), and the rows built server-side in
`sessionsList.tsx`.

**All three, not just the poll.** `mergeDiscoveredSessions` only synthesises
rows the server render did not know about; every already-known row keeps its
server-supplied data. Add `projects` to the poll alone and existing sessions
show no badges until something forces a server re-render — the same class of
bug the merge function exists to fix.

### 9.4 Layout

Badges sit in `ItemDescription`, which is already a `flex flex-col` holding the
date and the token usage — a row of chips underneath the date.

- Order: primary first, then observed by `firstAttachedAt`.
- Cap at two visible plus a `+N` overflow. The list is `max-w-sm`, and
  `GitStatusBadge` truncates at `max-w-40`, which is too wide for several chips
  in one row; the sidebar passes a narrower `className`.
- `SessionItem` is a stretched-link row (`after:absolute after:inset-0`). The
  badge already calls `stopPropagation` for the project-card case, which was a
  card-shaped button for the same reason, so it survives here unchanged.
- A session with no projects renders no chips and no empty row.

## 10. Out of scope

- Enforcement of any kind on writes (decision 3).
- Bash write detection (§6.3).
- Multi-repo wiki attribution (§8).
- Per-project branch state on the join table (§5).
- Dropping `sessions.project_path` — a follow-up migration once the mirror is
  no longer read.

---

## 11. Build order

Each step leaves the tree green.

1. ~~**Land the file-browser work first.**~~ Done — `session-project.ts`, the
   chokepoint everything here routes through, landed in `6ade370`.
2. `project-of-path.ts` + tests. Pure, no callers yet.
3. Per-session write serialisation in `session-meta.ts` + the interleaving test
   (§7).
4. `projects: ProjectLink[]` on `SessionMeta`, written as a mirror of the
   existing `projectPath`. Nothing reads it yet.
5. The `session_projects` migration + backfill from `sessions.project_path`,
   converting absolute to relative. Regenerate `database.types.ts`.
6. Dual-write: creation and the new explicit routes write disk and Postgres.
7. `sessionProjects()`, and move the git route, file browser and prompt block
   onto it. `projectPath` on disk becomes a written-but-unread mirror.
8. Observed attachment in the `tool_execution_start`/`end` handlers.
9. `showProjectName` / `showBranchStatus` on `GitStatusBadge` (§9.2), with the
   header and the project cards left on the defaults. Separable from everything
   above: it is a props change plus the conditional render guard, and it can be
   reviewed on its own before any badge consumes it.
10. `projects` through `SessionStatus`, `SessionRow` and the server-rendered
    rows (§9.3), then the chips in `session-item.tsx` (§9.4).
11. The session panel's anchor / touched-in-this-session sections (§9.1).
12. Follow-up: drop `sessions.project_path` and the disk mirror.

Steps 9–10 are worth doing even before step 8 lands: with one project per
session the chip is redundant against the header, but it proves the component
change and the data path under a case where the expected output is obvious.
