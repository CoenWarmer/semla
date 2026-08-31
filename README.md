# Semla

**Semla is a web-based agent Pi agent harness built for reliability and traceability.** It provides a persistent session interface for a coding agent, with first-class support for workflow orchestration, observability, and multi-repository workspaces.

The core design principle is that every agent run should be inspectable, repeatable, and correct. Semla does not optimise for autonomy at the expense of auditability — it records what the agent does, surfaces timing and token data, and keeps a full transcript of every subagent in every workflow.

---

## Features

- **Sessions** — Persistent conversations backed by Supabase. Resume any session from where it left off; full message history is retained across page reloads.
- **Workflow orchestration** — The agent can decompose tasks into parallel subagents. Progress is tracked in real time and surfaced in a panel alongside the conversation.
- **Timeline view** — Workflows are rendered as an OTel-style trace waterfall: phases, agents, and conversation events on a shared time axis. Conversation messages appear as inline event markers that scroll the chat when clicked.
- **Workspace project browser** — Semla scans the configured workspace root for git repositories and shows them on the home page as cards (branch, staleness). Clicking a card opens a new session pre-titled with the project name. A searchable combobox in the sidebar offers quick access to any repo.
- **Agent transcript viewer** — Drill into any subagent's full transcript, including its prompt rendered as markdown.
- **Model selection** — Models are loaded dynamically from the pi runtime; the active model is stored per user in user settings.
- **System prompt editor** — Override the orchestrator's system prompt from the settings page without a redeploy.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Framework | Next.js (App Router, Node.js runtime) |
| Auth & persistence | Supabase (Postgres + Auth) |
| Agent runtime | `@earendil-works/pi-coding-agent` |
| UI | Tailwind CSS, base-ui, shadcn components |
| State | TanStack Query |
| Workflow graph | React Flow (`@xyflow/react`) |
| Timeline view | `react-otel-trace-waterfall` |

---

## Getting Started

### Prerequisites

- Node.js 20+
- A Supabase project with the sessions, user_settings, and workflow tables provisioned
- An API key for the model provider (Anthropic, or any provider supported by the pi runtime)

### Install dependencies

```bash
npm install
```

### Configure environment

Copy the example below into `.env.local` and fill in the values:

```env
# Supabase
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...
SUPABASE_SERVICE_ROLE_KEY=sb_secret_...

# Agent runtime
PI_MODEL_API_KEY=sk-ant-...          # model provider API key

# Workspace
PI_WORKSPACE_ROOT=/Users/you/Dev     # directory scanned for git repositories

# Development only — allows the agent to access the host filesystem directly
PI_ALLOW_HOST_DEV=true
```

#### Environment variable reference

| Variable | Required | Description |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Yes | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Yes | Supabase anon/publishable key |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Supabase service role key (server-side only) |
| `PI_MODEL_API_KEY` | Yes | API key passed to the pi model runtime |
| `PI_WORKSPACE_ROOT` | No | Path the agent uses as its working directory. Defaults to `process.cwd()` when `PI_ALLOW_HOST_DEV=true`, or `/workspace` in sandboxed mode. Set this explicitly when developing — `process.cwd()` will be the Semla directory itself, not your projects root. |
| `PI_ALLOW_HOST_DEV` | No | When `true`, the agent runs directly on the host filesystem instead of inside a sandbox. Intended for local development only. |
| `PI_SANDBOXED` | No | When `true`, enforces sandboxed execution. Mutually exclusive with `PI_ALLOW_HOST_DEV`. |
| `PI_SESSION_DIR` | No | Where pi session transcripts are written. Defaults to `.semla-sessions/` inside the repo (gitignored) rather than a temp dir, so they survive a reboot. |
| `SEMLA_DISABLE_AUTH` | No | Development only. Skips the auth gate in `proxy.ts` so filesystem-backed pages such as `/wiki` stay reachable while Supabase is unavailable. Ignored when `NODE_ENV=production`. Anything that reads Supabase still fails. |
| `PI_CODING_AGENT_DIR` | No | Where pi keeps credentials and the model catalog. Defaults to `~/.semla/agent`, isolated from the `~/.pi/agent` the `pi` CLI uses. Seeded once from the host on first run so the model picker is not empty; after that the two are independent. |

### Run the development server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Log in with your Supabase credentials.

---

## Architecture

```
src/
  app/
    page.tsx                  Home page — workspace project browser
    sessions/[id]/            Session view
    settings/                 Runtime config, system prompt, packages
    api/
      sessions/               Create sessions, stream agent responses
      projects/               List workspace git repositories
      models/                 Available models from the pi runtime
  components/
    clientSessionComponent    Main session UI (conversation + workflow panel)
    session-workflow-panel    Workflow graph and timeline toggle
    projects-grid             Home page project cards
    projects-combobox         Sidebar project launcher
    agent-transcript-drawer   Per-agent transcript with markdown prompt
  lib/
    pi/
      session-service         Connects Supabase sessions to the pi agent loop
      workflow-service        Translates pi run state into WorkflowSnapshot
      workspace               Scans PI_WORKSPACE_ROOT for git repositories
      runtime-config          Central source for PI_* environment variables
    workflow-spans            Converts WorkflowSnapshot → OTel spans for the waterfall
```

### Isolation from the host

Semla runs pi in-process as a pinned library, not the `pi` binary on your PATH.
Extensions, skills and packages come from this repository, and credentials and
the model catalog live in `~/.semla/agent` rather than `~/.pi/agent`. That
directory is seeded once from the host so an existing pi install keeps working;
after that, changes made with the `pi` CLI no longer affect Semla. Delete it to
re-seed. In a container with no host install, credentials come from
`PI_MODEL_API_KEY`.

The model catalog is refreshed from the network once per server start, so a
seeded snapshot does not go stale as providers add models. It is best-effort —
if the fetch fails the catalog already on disk is used — and skipped entirely
when `PI_OFFLINE` is set.

The agent loop lives in `session-service.ts`. Each prompt streams events (assistant deltas, tool calls, workflow snapshots) over SSE to the client. Workflow progress is also polled from Supabase so background runs stay up to date after a page reload.

---

## Validation

Before committing, run:

```bash
npm run tsc    # type check
npm run lint   # eslint
```
