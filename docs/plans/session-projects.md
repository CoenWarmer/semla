# Plan: a session relates to zero, one, or many projects

**Goal:** replace the single `sessions.project_path` with an explicit relation
between a session and the projects it works in. A session may have none, one, or
several. Projects can be attached by the user at or after creation, and are
attached automatically when the agent writes to one. The relation is stored on
disk and in Postgres, disk authoritative.

**Status:** designed, not started. Written 2026-09-01. Eight open questions have
been put to the user and answered; each settled decision records the reasoning
rather than just the verdict, so a later reader can tell which way it went and
why. Nothing in §10 is undecided — it is deliberately deferred.

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
3. Take the **first path segment** under the root.
4. Return it if `getWorkspaceProjects()` lists it as a project; otherwise null.

**This is deliberately not a `.git` walk, and it is much simpler as a result.**
`getWorkspaceProjects()` scans exactly one level below the workspace root
(`workspace.ts`: `readdir(PI_WORKSPACE_ROOT)`, then `.git` on each child), so a
project *is* a first-level directory. Resolution is therefore a string split
plus a lookup in a list that is already cached for 5s — no filesystem access, no
per-process cache of its own.

### Nested repositories attach to their top-level parent

This matters concretely, not hypothetically. `/Users/coen/Dev` currently holds
checkouts like `semantic-code-search/.repos/elastic_kibana/.git` — real
repositories that `getWorkspaceProjects()` will never list.

A write to `semantic-code-search/.repos/elastic_kibana/src/foo.ts` attaches
**`semantic-code-search`**, not the inner checkout.

The alternative — walking to the nearest `.git` — gives more accurate
provenance and an unusable result: a project with no combobox entry, absent from
the projects grid, and whose badge popover would 400, because
`/api/projects/git` checks `isWorkspaceProject()` before acting and that reads
the same one-level listing. One definition of "project" across the badge, the
combobox, the grid, the file browser and the git actions is worth more than
sub-repo precision. The coarseness is a known limit, recorded in the docblock
alongside the bash gap.

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

## 7. `writeSessionMeta` is safe — because it is synchronous

*An earlier draft of this plan claimed appending to an array would race with
concurrent `isRunning` or `title` writes and silently drop links, and called for
a per-session promise chain. That was wrong, and the correction is worth
recording because the reasoning is what protects the invariant.*

`writeSessionMeta` is synchronous end to end — `mkdirSync`, `readFileSync`
inside `readSessionMeta`, then `writeFileSync`. There is no `async`, no `await`
and no `node:fs/promises` anywhere in `session-meta.ts`. Node runs it to
completion before any other callback, so two callers **cannot** interleave, and
the read-modify-write is atomic with respect to everything else in the process.
An array append is exactly as safe as a scalar patch.

The docstring's stated reason — "a session is written by the one process that
owns it" — covers the cross-process case, and single-user Semla has one server
process. Background continuations run in it too.

**What actually needs protecting is the synchrony itself.** The moment someone
switches this module to `fs/promises` — a natural-looking cleanup, since most of
the codebase is async — every claim above evaporates, and the failure is a
silently dropped link rather than an error. So instead of a promise chain:

- A comment on `writeSessionMeta` saying the synchrony is load-bearing for the
  array, not incidental.
- A test in `session-meta.test.ts` that appends from two callers and asserts
  both survive. It passes trivially today; it exists to fail the day the
  implementation goes async.

This costs two lines and a test instead of a mutex, and it pins the real
invariant rather than defending against a race that cannot occur.

---

## 8. Consumers

| Consumer | Change |
|---|---|
| `session-project.ts` | `sessionProjectPath()` → `sessionProjects()` returning `{ primary, links }`. Everything else follows from this one function. |
| `git/route.ts` | GET returns a record keyed by project path, like `/api/projects/git` already does; `readGitStatus` is already per-path. POST takes a `path`, validated against the session's own links before acting — see §9.3 for why that validation is load-bearing. |
| `file-browser.ts` | `basePath: string \| null` → `basePaths: string[]` — every attached project is a root. See §9.8. |
| `file-search.ts` | `inProject` becomes three bands — primary, other attached, workspace — which the existing coarse-band scoring absorbs without restructuring. |
| `prompts.ts` | "The active project is X" → the primary plus the attached list. |
| wiki stamp | The whole attached set, as a list. See below. |
| `sessions/route.ts` | Creates the first link. |

### The wiki is the deepest impact

`setSessionRepo(piRuntimeSessionId, repoSlugFromProjectPath(projectPath))`
(`session-service.ts:474`) binds one repo slug per pi runtime session, and that
drives how every captured wiki page is attributed. The wiki's *content* model
already handles multi-repo — `prompts.ts` teaches `repo: [semla, ecs]` as a YAML
list — but the stamp is singular.

The stamp becomes a list. Be aware this is a **cross-module-system contract
change**, which is why it is the deepest impact rather than the largest:

| File | Change |
|---|---|
| `extension-contract.ts:156` | `[WIKI_SESSION_REPOS]: Map<string, string>` → `Map<string, string[]>` |
| `wiki-session-repo.ts` | `setSessionRepo(id, repo: string \| null)` → a slug list |
| `wiki-ingest-bridge.ts:645` | `repoOf` reads the slot and yields a list |
| `wiki-subagent-tools.ts` | `registerSubagentWikiToolset(pi, repoOf, ...)` tags captured sources with it |

The two halves are loaded by *different module systems* — the server half
through Next's graph, the bridge through jiti, which is why the bridge reads the
`globalThis` slot directly instead of importing `getSessionRepo`. If they drift,
the failure is silent misattribution, precisely what `wiki-session-repo.ts` says
it exists to prevent. `extension-contract.test.ts` pins the shape; both sides
change in one commit or neither does.

### Stamp the turn's projects, not the session's

Tagging every page from a multi-project session with `repo: [a, b]` is more
accurate than tagging them all `a`, but a page purely about `b` still gets `a`
attached to it.

There is a strictly better answer available for free. §6.2 already accumulates
the set of projects touched **during the current turn** in order to batch the
writes, and `stampWikiRepo(semlaSessionId, projectPath, turnStartedAt)`
(`session-service.ts:771`) already runs per turn against a turn-start timestamp.
Feeding the *per-turn* set rather than the session-lifetime set costs nothing
extra and narrows the over-tagging to pages written in a turn that genuinely did
touch both repos.

Recommended: stamp the per-turn set, falling back to the primary when a turn
touched nothing.

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

### 9.2 One component, three surfaces

`GitStatusBadge` (`src/components/git-status-badge.tsx`) is already the branch
indicator, already knows how to address a project, and is already shared by the
app header and the project cards. It is not replaced; it gains two props.

```ts
/** Render the project's name. */
showProjectName?: boolean;  // default false
/** Render the branch ref, the ahead/behind counts, and the actions popover. */
showBranchStatus?: boolean; // default true
```

| Surface | Props | Result | Count |
|---|---|---|---|
| App header (`header-actions.tsx`) | `showProjectName` | name + branch + counts + popover | one per attached project |
| Sidebar row (`session-item.tsx`) | `showProjectName showBranchStatus={false}` | a compact name-only chip | one per attached project |
| Project cards (`projects-grid.tsx`) | defaults | unchanged — the card title is already the name | one |

Two changes to the component itself, both forced by the new surfaces:

**`showBranchStatus: false` must also suppress the popover.** Opening it fires
`refresh.mutate()`, which POSTs `action: "refresh"` and performs a real network
`git fetch`. The trigger opens *on hover* with a 250ms delay, so running the
pointer down a session list would fire a fetch per project passed over.
`GIT_FETCH_INTERVAL_MS` throttles per repository at 60s server-side, so this is
a waste rather than a hazard — but a chip that is deliberately not showing
branch state should not be offering "merge" and "check out" either. When
`showBranchStatus` is false the badge renders a plain, non-interactive chip.
*A judgement call; a third prop could separate the popover from the counts if
that turns out to be wanted.*

**`if (!label) return null` has to become conditional.** Today the badge renders
nothing when git has nothing to say, and the docblock defends that: "An empty
slot reads better here than a placeholder next to the model picker." Still right
for a branch-only badge — but a named badge should show its project when the
repo has no commits or git is unavailable, because the relation is a fact
independent of git state. The guard becomes: return null only when there is
neither a name nor a label to show.

### 9.3 App header: every related project, named, with its branch

The header shows one badge per attached project, side by side, each carrying the
project name *and* its branch status. Today it shows a single unnamed branch
badge; a session working in three repos should say so at the top of the screen.

**Keep `{ kind: "session" }` here, and give the route a record.**

This is the opposite of the sidebar's answer (§9.4), and deliberately so. The
distinction `use-git-status.ts` draws is between *fetching* and *not fetching*:

> A session knows its project and is the only repository on screen, so it is
> read one at a time and may fetch. A card is one of dozens, so the whole
> workspace is read in a single request and none of it fetches until you open a
> card's popover.

Multiple header badges falsify the literal premise — the session is no longer
"the only repository on screen" — but not the reasoning. The header is where
freshness matters most, because it is *the* branch indicator and the whole
reason `fetchCanonical` exists is that stale refs lie: the module notes a branch
that "showed up to date while 432 commits behind". A session's handful of repos
is still not a workspace's fifty.

So `/api/sessions/[id]/git` returns a record keyed by project path, exactly as
`/api/projects/git` already does, and the session target grows an optional
`path` so each badge indexes into it:

```ts
| { kind: "session"; sessionId: string; path?: string }
```

The query key stays `["git-status", "session", sessionId]`, so **all the header
badges share one request** however many there are, and `useGitStatus` ends up
doing `data[target.path]` for *both* variants — the two branches of the hook
become more alike, not less.

Fetch cost is bounded: a session with three projects fetches three repositories,
each throttled to once per 60s by `GIT_FETCH_INTERVAL_MS`, against a 30s poll.

**The POST invariant must survive.** The route's docblock states a property the
code currently holds:

> The request names an action and nothing else. Refs are re-resolved here from
> the same read the badge renders, so a caller cannot aim either operation at a
> repository or a ref of its choosing.

Concretely: today the body is `{ action }`, and `projectPath` comes from
`sessionProjectPath(id)` on the server. `mergeIntoCurrent(path, base)` and
`checkoutBranch(path, branch)` run git in whatever directory they are handed, so
"the client never names the directory" is the whole of the control.

Per-project actions require the client to name a project, which removes it. The
naive version — `checkoutBranch(body.path, branch)` — lets any caller run git in
any directory on the machine.

The fix already exists in this codebase, one route over. `/api/projects/git` has
the identical problem and says so:

> Unlike the session route, the path comes from the client — so it is checked
> against the workspace listing before anything runs.

The session route does the same, with the allowlist being "a project attached to
*this* session", which `sessionProjects()` answers directly. Refs stay
server-resolved either way.

**Do it, but for the right reason.** Semla is a single-user system today, bound
to loopback, where `AUTH_REQUIRED` is false and nothing off the machine can
reach the route. The only client is the owner's own browser, and the agent —
which could in principle POST to the local API — already holds an unrestricted
`bash` tool, so the endpoint grants it nothing it does not already have. As a
*security* control here, the allowlist buys approximately nothing, and it would
be dishonest to argue it in those terms.

It is still worth the three lines:

- A wrong or stale path fails as a clear 400 instead of running git somewhere
  unintended.
- It keeps the route's documented property true rather than leaving a docblock
  that describes code that no longer behaves that way — the worst kind, because
  the next reader trusts it.
- It is the difference between a bounded and an unbounded operation on the day
  the system stops being single-user, and it costs nothing to have already done.

**Deferred, by decision.** The git route calls neither `requireSessionOwner` nor
`requireUser`, and it is not alone — `files/route.ts`, `files/content/route.ts`,
`files/search/route.ts` and `workflows/route.ts` do not either, while `prompt`,
`stream`, `messages`, `stop`, `composition`, `context-check` and the rest do.
Under `AUTH_REQUIRED` that would let any signed-in user read another user's
session files and act on its repositories.

This is deliberately *not* being fixed here. Semla is single-user, so the gap
has no consequence today, and a route-by-route authorisation audit is its own
piece of work with its own tests. It belongs with whatever makes Semla
multi-user, and the list above is the starting point for it.

**Space.** Render every attached project — no cap, no `+N` overflow. The header
is `h-11` with `px-2` and `gap-1` (`layout.tsx:56`) and already carries the
sidebar trigger, the Files button and the cost badge, but a session accumulates
projects one write at a time and in practice holds a handful, not a screenful.
A cap would be machinery for a case that does not arise, and hiding a project
behind `+N` defeats the point of showing them.

- Order primary first, then observed by `firstAttachedAt`.
- `GitStatusBadge` truncates the ref at `max-w-40`. With a name alongside it and
  several badges in a row, the header passes something narrower.
- Zero projects renders nothing at all, exactly as today.
- Revisit only if a real session turns out to overflow; the badge group can
  scroll or collapse then, with an actual case to design against.

### 9.4 Sidebar: a name-only chip per project

Every session row in the sidebar carries one chip per project it relates to.

**Use `{ kind: "project", path }` here, never `{ kind: "session" }`.** The
sidebar is the "dozens of repositories" case the hook was designed for: thirty
sessions on `{ kind: "session" }` would be thirty polling queries, each able to
trigger a fetch. The project variant shares a single workspace-wide query across
every chip on screen and never fetches from the poll —

> Every card shares one workspace query, so a page of forty projects makes one
> request rather than forty.

Note that `/api/projects/git` keys its record by the *absolute* path
(`workspace-git.ts:63`, from `getWorkspaceProjects()`), so the sidebar resolves
each link's workspace-relative path against the root before passing it. Relative
stays the stored identity; absolute is the wire format that one endpoint speaks.

### 9.5 Getting the data there — free, as it happens

`/api/sessions/status` is built from `listSessionMeta()`: disk only, no
database, no per-session query. The links live on that same record, so
`projects` rides along at zero cost and the route keeps the property its
docblock is proud of — the sidebar works when Postgres does not.

Three types grow the field: `SessionStatus` (`src/lib/session-status.ts`),
`SessionRow` (`sessions-list-client.tsx`), and the rows built server-side in
`sessions-list.tsx`.

**All three, not just the poll.** `mergeDiscoveredSessions` only synthesises
rows the server render did not know about; every already-known row keeps its
server-supplied data. Add `projects` to the poll alone and existing sessions
show no chips until something forces a server re-render — the same class of bug
the merge function exists to fix.

The header reads the session's own links rather than this list, since it already
has the session id and needs the ordering anyway.

### 9.6 Sidebar layout

Chips sit in `ItemDescription`, which is already a `flex flex-col` holding the
date and the token usage — a row of chips underneath the date.

- Order: primary first, then observed by `firstAttachedAt`.
- Cap at two visible plus a `+N` overflow. The list is `max-w-sm`, and
  `GitStatusBadge` truncates at `max-w-40`, which is too wide for several chips
  in one row; the sidebar passes a narrower `className`.
- `SessionItem` is a stretched-link row (`after:absolute after:inset-0`). The
  badge already calls `stopPropagation` for the project-card case, which was a
  card-shaped button for the same reason, so it survives here unchanged.
- A session with no projects renders no chips and no empty row.
- **The chip is not clickable.** Because the row is a stretched link, a click
  anywhere — the chip included — opens the session. Filtering the list by
  project is the obvious thing a many-to-many unlocks, and deliberately not done
  here: it needs filter state, a way out of it, and an empty state, none of
  which belong in this change.

### 9.7 The `?project=` search param is vestigial

Opening a project from the sidebar combobox or a project card navigates to
`/sessions/<id>?project=<name>` (`projects-combobox.tsx:51`,
`projects-grid.tsx:57`).

**Nothing reads it.** `sessions/[id]/page.tsx` takes only `params`, never
`searchParams`, and the only `useSearchParams` calls in the app are the wiki's
`page` and login's `next`. The real association travels in the POST body as
`projectPath`, which becomes `sessions.project_path` and `SessionMeta.projectPath`.
The param is decoration, and it is already redundant with the session title,
which is set to the project name by the same call.

So nothing breaks. But under this plan it becomes actively misleading: a URL
naming one project, for a session that may relate to several, which never
updates as the agent attaches more. A search param looks like state; this one is
a label that goes stale on the first write to a second repo.

**Drop it.** Both call sites push a plain `/sessions/<id>`.

There is one thing it could legitimately become, and it is deliberately deferred
to §10: once the header shows a badge per project (§9.3) and the file tree has a
root per project (§9.8), `?project=` could name which one is focused —
deep-linking to a project's view *within* a session. That gives the param a real
job instead of a decorative one, but it is a new feature rather than a
consequence of this change, and it should not be designed on the back of a
parameter that currently does nothing.

### 9.8 File browser: one root per attached project

The tree shows every attached project as a sibling root, rather than opening on
the primary alone.

- `resolveFileRoot()` returns `basePaths: string[]` instead of
  `basePath: string | null`, ordered primary first.
- `session-files-panel.tsx` renders one `SessionFileTree` per root.
  `filesQueryKey(sessionId, dirPath)` is already keyed by directory, so several
  roots coexist in the cache with no change to the query layer.
- `/api/sessions/[id]/files` keeps taking an explicit `?path=`; the client asks
  for each root by name. Only the no-path default changes — from "the primary"
  to "the list of roots", which the panel then fans out.
- Search `scope=project` loops the attached projects over one shared budget.
  `listProjectFiles()` in `project-files.ts` is already per-project and uses
  `git ls-files` rather than a walk, so N projects is N cheap index reads rather
  than N directory sweeps.

A session with one project renders exactly what it renders today, so this is
additive rather than a change to what just shipped.

Worth being clear about the cost: `session-file-tree.tsx` assumes a single root,
and the panel's selected-file state is one path scoped to that root. Both become
per-root. This is the largest UI change in the plan.

---

## 10. Out of scope

- Enforcement of any kind on writes (decision 3).
- Bash write detection (§6.3).
- Sub-repository precision — a write inside a nested checkout attaches its
  top-level parent (§6.2).
- Per-page wiki attribution. The stamp becomes a per-turn list (§8), which is
  better than one slug and still not per-page.
- Filtering the sidebar by project (§9.6).
- A route-by-route authorisation audit. Semla is single-user today; the missing
  ownership checks listed in §9.3 belong with the work that makes it
  multi-user, not with this change.
- Deep-linking a project within a session. `?project=` is being deleted rather
  than repurposed (§9.7); giving it a real job — focusing one header badge and
  one file-tree root — is a feature to design on its own, not on the back of a
  parameter that currently does nothing.
- Per-project branch state on the join table (§5).
- A project picker on `/sessions/new`, which today POSTs to `/api/sessions` with
  no body at all. Auto-attach covers it: the session adopts its project on the
  first write.
- Dropping `sessions.project_path` — a follow-up migration once the mirror is
  no longer read.

---

## 11. Build order

Each step leaves the tree green.

1. ~~**Land the file-browser work first.**~~ Done — `session-project.ts`, the
   chokepoint everything here routes through, landed in `6ade370`.
2. `project-of-path.ts` + tests. Pure, no callers yet.
3. The synchrony comment on `writeSessionMeta` + the two-writer test that pins
   it (§7). Not a mutex — see that section for why the race cannot occur.
4. `projects: ProjectLink[]` on `SessionMeta`, written as a mirror of the
   existing `projectPath`. Nothing reads it yet.
5. The `session_projects` migration + backfill from `sessions.project_path`,
   converting absolute to relative. Regenerate `database.types.ts`.
6. Dual-write: creation and the new explicit routes write disk and Postgres.
7. `sessionProjects()`, and move the git route, file browser and prompt block
   onto it. `projectPath` on disk becomes a written-but-unread mirror.
8. Observed attachment in the `tool_execution_start`/`end` handlers.
9. `showProjectName` / `showBranchStatus` on `GitStatusBadge` (§9.2), with every
   existing call site left on the defaults. Separable from everything above: a
   props change plus the conditional render guard, reviewable on its own before
   any badge consumes it.
9a. `/api/sessions/[id]/git` GET returns a record; `GitTarget`'s session variant
    grows `path?`; `useGitStatus` indexes both variants the same way. Behaviour
    is unchanged while the header still renders one badge, so this lands as a
    pure refactor with the existing UI as its test.
9b. The header renders one badge per attached project (§9.3), and POST grows the
    `path` plus its allowlist check. The allowlist and the multi-badge render
    belong in the same commit — shipping the parameter before the validation is
    the failure mode §9.3 warns about.
10. `projects` through `SessionStatus`, `SessionRow` and the server-rendered
    rows (§9.5), then the chips in `session-item.tsx` (§9.4, §9.6).
11. The session panel's anchor / touched-in-this-session sections (§9.1).
12. File browser sibling roots (§9.8) — the largest UI change, and independent
    of everything above it once `sessionProjects()` exists.
12a. Drop `?project=` from both navigation call sites (§9.7). One line each,
     and nothing reads it.
13. The wiki stamp as a per-turn list (§8). Both sides of the
    `WIKI_SESSION_REPOS` contract in one commit, with
    `extension-contract.test.ts` updated alongside.
14. Follow-up: drop `sessions.project_path` and the disk mirror.

Steps 9–10 are worth doing even before step 8 lands: with one project per
session the chip is redundant against the header, but it proves the component
change and the data path under a case where the expected output is obvious.
