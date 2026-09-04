# Plan: MCP servers for Semla's agent

**Goal:** let a Semla session use MCP servers — filesystem, browser, issue
trackers, whatever the operator configures — without the agent's context being
consumed by hundreds of tool definitions it will not use.

**Status:** designed and spiked 2026-09-04; Phase 1 (§6) implemented. §2 records
what the spike actually did and found; the recommendation in §3 rests on it
rather than on the package's documentation, which is wrong about the one thing
that mattered.

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
`src/lib/pi/extensions/mcp-package-contract.test.ts`. Phases 2–4 remain open.

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

**Decision: pin the config path.** `index.ts:197` reads
`options.configPath ?? getConfigPathFromArgv()`, and `getConfigPathFromArgv`
looks for `--mcp-config <path>` in `process.argv`. Appending that at server boot
pins one file and bypasses the precedence chain entirely.

**Why pin rather than share.** An MCP server entry is a `command` and its
`args` — it is arbitrary process execution, described in a file. Sharing one
`mcp.json` across tools is a real convenience and a defensible default for a
single-user machine, so this is a judgement rather than a rule. It is pinned
because Semla should be able to state what its agent can reach, and because
"the agent gained a capability from a file written for a different tool" is
precisely the kind of thing this codebase writes tests to prevent. An operator
who wants the shared file can point the pin at it, in one place, on purpose.

**Keeping `.pi/` gone.** The adapter writes protocol traces to `.pi/mcp-traces/`
when they are enabled, and a project override to `.pi/mcp.json` if one is
created. Pinning the config path and leaving traces off means neither happens,
and `pi-dir-removed.test.ts` keeps holding.

---

## 6. Phases

**0 — Spike.** Done; §2.

**1 — Load it.** Exact pin in the root `package.json`, the two path constants,
the manifest entry, and the contract test: version pinned, tool set asserted
against the installed package, and the peer edges asserted to resolve to
`@earendil-works` rather than `@mariozechner`, because that is the failure that
would come back silently.

**2 — Pin the configuration.** `--mcp-config` at boot, pointing at
`~/.semla/agent/mcp.json`; a test that the pinned path is what the adapter reads.

**3 — Make it visible.** The panel already advertises `EXTENSION_TOOLS`. Decide
whether `mcp` joins `PI_TOOLS` so it can be toggled per turn, and surface which
servers are connected — a gateway tool that silently has no servers is the same
class of failure `extension-health` exists for.

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
