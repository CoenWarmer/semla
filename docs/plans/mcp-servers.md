# Plan: MCP servers for Semla's agent

**Goal:** let a Semla session use MCP servers — filesystem, browser, issue
trackers, whatever the operator configures — without the agent's context being
consumed by hundreds of tool definitions it will not use.

**Status:** designed and spiked 2026-09-04; Phases 1–3 (§6) implemented. §2
records what the spike actually did and found; the recommendation in §3 rests
on it rather than on the package's documentation, which is wrong about the one
thing that mattered — and §5's own original proposal turned out to be wrong
about a second thing, corrected during implementation and noted inline below.

**Phase 1 note:** pinned to `pi-mcp-adapter@2.29.0`, not the then-latest
2.32.1 — this sandbox's npm refuses anything published after 2026-08-28 (see
§7), so 2.32.1 (published 2026-09-01) is unreachable here. Re-check that cap
before bumping the pin. The peer-dependency and native-dependency checks in §3
held exactly as spiked: `@modelcontextprotocol/client@2.0.0`, peers resolving
to the pinned `@earendil-works` runtime with no `@mariozechner` peer to alias
away, and `@napi-rs/keyring` installing via optional dependencies with no
postinstall script. Landed as `MCP_PACKAGE_DIR`/`MCP_EXTENSION_PATH` in
`runtime-config.ts`, a `kind: "path"` manifest entry (`providesTools: ["mcp"]`,
`optionalTools: ["mcpScript"]`), and
`src/lib/pi/extensions/mcp-package-contract.test.ts`.

**Phase 2 note:** the plan's original `--mcp-config` approach turned out not to
work — see the revised §5 and §6 below. `PI_MCP_CONFIG_MODE=exclusive` is what
actually collapses the package's six-source precedence chain to one file, and
an env var (not an argv flag) is the right mechanism for a long-lived server
process. Landed as `src/lib/pi/mcp-config.ts`, called from
`instrumentation.ts`. Phases 3–4 remain open.

---

## 1. What is actually true today

**Pi has no MCP support.** Checked against the pinned
`@earendil-works/pi-coding-agent@0.84.2`:

- no MCP dependency among its 21;
- nothing on the extension API surface — no `registerMcp`, `McpClient`,
  `mcpServer`, no `modelcontextprotocol` import anywhere in its own `dist/`;
- exactly one mention, a comment in `dist/utils/tool-result-images.d.ts`
  describing "extensions, MCP bridges, screenshot tools" as *external*
  producers of images.

That last one is the useful signal: pi is written expecting MCP to arrive as an
extension. So the question was never "extension or built-in", only whose
extension — one this repository writes, or `pi-mcp-adapter`.

---

## 2. The spike

Run against `pi-mcp-adapter@2.29.0`, installed with npm and loaded the way Pi
loads a path extension — jiti compiling the TypeScript in place — then bound to
a stand-in `ExtensionAPI` recording what it registered.

```
JITI_LOAD: ok, default export is function
BIND:      ok
TOOLS:     ["mcpScript", "mcp"]
EVENTS:    ["pi-mcp-adapter:runtime-register:v1", "session_start",
            "input", "session_shutdown", "tool_result"]
COMMANDS:  ["mcp", "pi-mcp", "mcp-auth"]
```

**The decisive finding: `pi install` is not required.** The package's README
says the adapter "must be installed through pi" and cannot be loaded as a plain
extension path. That is not so, and it matters enormously here — taking the
documented route would recreate `.pi/npm`, which is the failure AGENTS.md spends
a page on and `pi-dir-removed.test.ts` exists to prevent.

Two facts contradict the documentation:

- the package declares `"pi": { "extensions": ["./index.ts"] }` — a plain path,
  which is all `pi install` would have written into a package list anyway;
- `index.ts:1207` is `export default createMcpAdapter()`, which is exactly the
  shape Pi's path loader calls.

The jiti load is the part that could not be assumed. AGENTS.md warns that "an
import that type-checks can still fail to load", and this is 1,207 lines of
TypeScript importing some twenty sibling `.ts` modules. It compiles.

**What else the spike settled.** Both tools register under default options, so
the manifest can assert them. The three slash commands are dead weight in Semla
— there is no TUI to put them in — but harmless.

---

## 3. Decision: adopt the adapter rather than build one

**Why not build.** The realistic scope of our own is transports (stdio, HTTP,
socket), tool discovery and caching, call marshalling, lifecycle and idle
timeouts, OAuth, and output guarding — 400 to 700 lines with tests, to avoid
one manifest entry. That trade only makes sense if the package is unsafe to
take, and the three things that would have made it unsafe are all clean:

| Checked | Result |
|---|---|
| MCP implementation | `@modelcontextprotocol/client@2.0.0` — the **official** SDK, from `modelcontextprotocol/typescript-sdk` |
| Peer dependencies | `@earendil-works/pi-ai ^0.84.1`, `pi-tui *`, `typebox *`, `zod ^3.25 \|\| ^4` — the **current** scope, all satisfied by what this repository already pins |
| Native dependency | `@napi-rs/keyring` ships per-platform **optional dependencies**, not a postinstall download |

The peer-dependency line is the one that was worth checking properly.
`@zosmaai/pi-llm-wiki` declares a wildcard peer against the abandoned
`@mariozechner` scope, and npm answered it by installing a second, older agent
runtime carrying a credential-exposing advisory. This package points at the
scope pi actually uses now, so it cannot reproduce that.

The keyring line matters because this repository gates install scripts. Older
`@napi-rs` packaging fetched a binary in `postinstall`, which would have needed
an `allowScripts` entry to work at all; the current optional-dependency form
needs nothing — the same packaging change that made `@vscode/ripgrep` easy to
take.

**And the design is right.** One `mcp` gateway tool of roughly 200 tokens that
discovers and calls on demand, instead of registering every server's tools at
startup. For a harness that already watches its context composition closely,
that is the design we would have had to arrive at anyway.

---

## 4. How it loads

Three things, each with a home already:

1. **`MCP_PACKAGE_DIR` and `MCP_EXTENSION_PATH` in `runtime-config.ts`** — one
   place every path into the package derives from, as `WIKI_PACKAGE_DIR` is.
2. **An `EXTENSION_MANIFEST` entry**, `kind: "path"`, `requires: []`.
3. **A contract test**, in the mould of `code-intelligence-contract.test.ts`.

**Path, not factory** — the exception AGENTS.md already carves out. The package
publishes TypeScript; Node refuses to strip types under `node_modules`, and a
static import would drag tsc into source that does not type-check here. jiti
transpiles in place, which is why the package expects it.

**`providesTools: ["mcp"]`, `optionalTools: ["mcpScript"]`.** The spike saw both
register, so both *could* be asserted — but scripting can be turned off by
configuration, and a session that refuses to boot because the operator disabled
a feature would be the verification working against its own purpose. The gateway
is the thing whose absence means the extension silently did nothing.

Nothing else is needed to surface it: `EXTENSION_TOOLS` is derived from the
manifest and is what `/api/tools` advertises to the UI. Adding it to `PI_TOOLS`
is a separate decision — that list is `toggleableTools`, the ones the prompt bar
lets an operator switch off per turn.

---

## 5. Configuration, and the isolation question

The adapter searches six locations, in precedence order:

```
~/.config/mcp/mcp.json          user-global, shared across tools
~/.agents/mcp.json              tool-agnostic
~/.agents/mcp/mcp.json          tool-agnostic
$PI_CODING_AGENT_DIR/mcp.json   Pi global override
.mcp.json                       project-local, shared
.pi/mcp.json                    Pi project override (highest)
```

Two of those are host-global and outrank the agent directory. Semla already sets
`PI_CODING_AGENT_DIR` to `~/.semla/agent`, so the fourth entry and the metadata
cache land inside Semla's own directory for free — but the first two would still
win.

**Decision, revised during implementation: pin the config *mode*, not a
`--mcp-config` path.** The original plan here read `index.ts:197`'s
`options.configPath ?? getConfigPathFromArgv()` as bypassing the precedence
chain. It does not: reading `config.ts`'s `getConfigSources()` directly shows
an `overridePath` only replaces the *pi-global* entry's path — the two
host-global sources (`~/.config/mcp/mcp.json`, `~/.agents/mcp.json` and its
nested form) and the project sources are still pushed onto the list and merged
in regardless. `--mcp-config` narrows *where the pi-global file lives*; it does
not narrow *how many files are read*.

What actually collapses the chain is `PI_MCP_CONFIG_MODE=exclusive`.
`getConfigSources()` early-returns a single `"pi-global"` entry when
`isExclusiveConfigMode()` is true, host-config auto-discovery
(`loadDiscoveredHostConfigs`, importing from Cursor/Claude/etc.) is switched
off, and `loadMcpConfig()` skips package and agent-plugin configs too via the
same early return — confirmed by reading and exercising `config.ts` directly
with jiti, not assumed from the package's docs (see
`src/lib/pi/mcp-config.test.ts`).

That single remaining source is `getAgentPath("mcp.json")` — inside whatever
`PI_CODING_AGENT_DIR` points at, which is already Semla's own agent directory
(`isolatePiAgentDir()` in `agent-dir.ts`). So no `--mcp-config` value is needed
at all: setting the mode is sufficient, and pinning it as an env var read at
call time is also the safer mechanism for Semla specifically — it is one
long-lived Next.js process serving concurrent sessions, and a flag pushed onto
`process.argv` at boot would still be present for every request the process
ever handles afterwards, where `process.env.PI_MCP_CONFIG_MODE` is read fresh
by `isExclusiveConfigMode()` on every call with no such leak.

**Why pin rather than share.** An MCP server entry is a `command` and its
`args` — it is arbitrary process execution, described in a file. Sharing one
`mcp.json` across tools is a real convenience and a defensible default for a
single-user machine, so this is a judgement rather than a rule. It is pinned
because Semla should be able to state what its agent can reach, and because
"the agent gained a capability from a file written for a different tool" is
precisely the kind of thing this codebase writes tests to prevent. An operator
who wants the shared file back can set `PI_MCP_CONFIG_MODE` themselves before
Semla starts — `isolateMcpConfigMode()` reads any value already present in the
environment before defaulting to `exclusive`, the same precedence
`isolatePiAgentDir()` already gives `PI_CODING_AGENT_DIR`.

**Keeping `.pi/` gone.** The adapter writes protocol traces to `.pi/mcp-traces/`
when they are enabled, and a project override to `.pi/mcp.json` if one is
created. Pinning the config path and leaving traces off means neither happens,
and `pi-dir-removed.test.ts` keeps holding.

---

## 6. Phases

**0 — Spike.** Done; §2.

**1 — Load it.** Done. Exact pin (`pi-mcp-adapter@2.29.0`; the sandbox's npm
caps at packages published before 2026-08-28, so `2.32.1` was unreachable and
must be re-checked before any bump) in the root `package.json`,
`MCP_PACKAGE_DIR`/`MCP_EXTENSION_PATH` in `runtime-config.ts`, a manifest entry
in `extension-manifest.ts` (`providesTools: ["mcp"]`,
`optionalTools: ["mcpScript"]`), and
`src/lib/pi/extensions/mcp-package-contract.test.ts`: version pinned, tool set
asserted against the installed package, and the peer edges asserted to resolve
to `@earendil-works` with no `@mariozechner` wildcard to alias away.

**2 — Pin the configuration.** Done, but not as originally written here — see
the revised §5 above. `PI_MCP_CONFIG_MODE=exclusive`, set by
`isolateMcpConfigMode()` in `src/lib/pi/mcp-config.ts` and called from
`instrumentation.ts` right after `isolatePiAgentDir()`, so the one remaining
config source lands inside `~/.semla/agent/mcp.json`.
`src/lib/pi/mcp-config.test.ts` proves the pinned mode collapses the package's
own `getConfigDiscoveryPaths()` to exactly that path.

**3 — Make it visible.** Done. `mcp` was **not** added to `PI_TOOLS`: it stays
an always-active extension tool, and the prompt editor already renders
extension tools — `mcp` included, no code change needed — under "Extensions
(always active)" in its tool picker, non-toggleable, which is consistent with
§4's framing that `PI_TOOLS` is specifically the *toggleable* set.

Connection status (connected / needs-auth / failed) is only known inside a
running session — the package publishes it as an event on that session's own
`ExtensionAPI` instance, not anywhere a route handler can reach without one
running. What a route handler *can* read cheaply is the pinned config file
itself: `getMcpConfigSummary()` in `src/lib/pi/mcp-config.ts` deep-imports
`pi-mcp-adapter`'s compiled `dist/config.js` for the exported `loadMcpConfig`
— a pure file read with no connection attempted — and reports server names and
count. `getExtensionHealth()` (now async) surfaces this as `mcp:
McpConfigSummary | null`, and the settings page's extension health card renders
it: an unreadable file is shown as an error, zero configured servers as a
neutral "None configured" (an operator who has not written an `mcp.json` yet is
a valid, inert state — not a degradation), and N servers as their names.
`src/lib/pi/mcp-config-summary-contract.test.ts` is the compensating check for
the deep import, in the mould of `WIKI_PACKAGE_DEEP_IMPORTS`.

**4 — Document it.** Where `mcp.json` lives, and what putting a server in it
grants the agent.

---

## 7. Risks

| Risk | Mitigation |
|---|---|
| Fast cadence — 63 versions, latest published three days ago | Exact pin plus the contract test; upgrades are deliberate |
| This sandbox's npm refuses anything published after 2026-08-28, so 2.32.1 is unreachable and 2.29.0 is the newest installable | Confirm the cap does not apply on the target machine before choosing a version |
| Three slash commands registered with no TUI to host them | Harmless; no option to suppress them |
| 2.9 MB and twelve dependencies, including a native keyring | Accepted: it is server-side, and the keyring is how OAuth tokens stay out of plaintext |
| A server in `mcp.json` is arbitrary process execution | Pinned config path (§5); the operator writes that file deliberately |

---

## 8. Deferred

- OAuth server flows, and the credential UI around them.
- Per-server direct tools — registering a server's tools individually rather
  than behind the gateway. The context cost is the reason the gateway exists.
- `mcpScript`. It is a JavaScript execution surface; worth its own decision.
- Surfacing MCP server health in the session UI.
