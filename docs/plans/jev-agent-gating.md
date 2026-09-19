# Plan: Jev-based gating of skills, tools, and MCP sources

**Goal:** before / during each turn, ask TypeSafe's Jev model (via
OpenRouter's alpha Decisions API, `~typesafe/jev-latest`) which skills, tools,
and MCP sources are actually relevant to what the user is asking, and narrow
what the main agent can see accordingly — rather than always exposing the
full static set declared in `PI_TOOLS` / `extension-manifest.ts` /
`WORKFLOW_SKILLS_PATH` / `mcp.json`.

**Status:** plan only. Nothing below is implemented yet.

**Scope decided with the operator (2026-09-xx):**
- Filtered categories: skills, tools, MCP sources (servers/tool groups), in
  that order of priority — skills and tools are both fully controllable
  through Pi's extension API; MCP source filtering is a coarser, partial win
  (see §4).
- Timing: **mid-turn**, not just once before the turn starts. The filter can
  re-run as context changes (mirrors `read-router.ts`'s pattern of a
  `tool_result`-driven re-evaluation, not just a one-shot `before_agent_start`
  decision).
- Failure mode: **fail closed**. If the Jev call errors, times out, or
  returns something unparseable, the agent falls back to a **minimal safe
  tool/skill set**, not the full set. This is the opposite of `read-router.ts`
  (which fails open to raw output) and is a deliberate difference — a
  filtering gate that fails open is equivalent to having no gate, and Semla's
  reliability principle favors an agent that is under-provisioned over one
  that is silently over-provisioned.

---

## 1. What Jev actually is (verified against the OpenRouter page)

`~typesafe/jev-latest` is not a chat/completion model. It is queried through
a separate endpoint:

```
POST https://openrouter.ai/api/alpha/decisions
Authorization: Bearer $OPENROUTER_API_KEY
Content-Type: application/json

{
  "model": "~typesafe/jev-latest",
  "state": <string | object | array>,
  "questions": {
    "<key>": {
      "type": "noul" | "choice" | "score",
      "instructions": "<question text>",
      "criteria": { ... } | [ ... ]
    },
    ...
  }
}
```

It returns calibrated probabilities per question (`noul`: 0–1 yes/no;
`choice`: a pick plus a probability distribution over options; `score`: a
position on an ordered rubric). It does not generate text and is not
reachable through `ModelRegistry.complete()`, which is shaped for chat
completions. It needs its own client.

This is the same shape of "ask a cheap model a narrow typed question and let
code act on the answer" that `read-router.ts` already does for compression
decisions and that `chooseCheapModel()` already generalizes for model
selection — but through a different endpoint and response shape, so it is a
new client, not a reuse of `chooseCheapModel`/`ModelRegistry`.

## 2. Where this plugs into Semla today

Relevant existing seams, found by reading the extension surface
(`@earendil-works/pi-coding-agent`'s `ExtensionAPI`/`ExtensionContext`) and
Semla's own session-build path:

- **Tools.** `session-service.ts` calls `session.setActiveToolsByName([...tools, ...extensionTools])`
  once per turn, after `bindExtensions`. Independently, any extension can call
  `pi.setActiveTools(names)` (`ExtensionActions`) at any point during a
  session — `workflow.ts`, `workflow-editor.ts`, and `workflow-commands.ts`
  already do this to add/restore tools around a single call. This is the hook
  a mid-turn Jev re-evaluation would use: re-run `setActiveTools` from a
  `tool_result` or `turn_start` handler, the same event `read-router.ts`
  already subscribes to for a different purpose.
- **Skills.** Skills are discovered once, from `additionalSkillPaths`
  (`WORKFLOW_SKILLS_PATH`, set in `session-service.ts`) plus Pi's own
  defaults, and rendered into the system prompt via `formatSkillsForPrompt`.
  There is no live "hide skill X this turn" API — the two real levers are:
  (a) `resources_discover`, fired once after `session_start`, which can add
  *additional* skill paths but not remove default ones; and (b)
  `before_agent_start`, which hands the extension the fully-assembled
  `systemPrompt` string and `systemPromptOptions`, and lets it **return a
  replacement `systemPrompt`**. Filtering skills in practice means
  reconstructing the system prompt with only the Jev-approved skills'
  `<skill>` blocks — using the same `formatSkillsForPrompt`-shaped XML, built
  from a filtered skill list, then substituted for the skills section of the
  assembled prompt. `before_agent_start` fires once per user prompt (not
  literally every model turn inside an agent loop), so "mid-turn" for skills
  in practice means "re-decided every user prompt" — true continuous
  intra-loop skill swapping is not exposed by the SDK.
- **MCP sources.** MCP servers are configured entirely through the one file
  `MCP_CONFIG_PATH` (`~/.semla/agent/mcp.json`, in exclusive mode — see
  `mcp-config.ts`), read once by `pi-mcp-adapter` at session bind time when it
  registers its `mcp` / `mcpScript` tools. There is no documented per-turn
  "enable subset of servers" call on the adapter's `ExtensionAPI` surface (no
  `registerMcp`/server-toggle handler found in its `dist/`). Two paths exist,
  neither exact:
  1. **Coarse:** treat "MCP sources" as the two tools `mcp` / `mcpScript`
     themselves, and gate them like any other tool via `setActiveTools`. This
     is mid-turn-capable and needs no new machinery, but it is all-or-nothing
     across every configured server.
  2. **Finer, session-start only:** rewrite `MCP_CONFIG_PATH` before
     `resourceLoader.reload()` runs, marking servers Jev doesn't think are
     relevant as `disabled: true`, so only some servers are ever connected.
     This changes per-turn *only if a new session/turn causes a config
     re-read*, which does not happen mid-conversation — so it satisfies the
     "sources" half of the ask but not the "mid-turn" half. Flagged as a
     known gap rather than silently promised.

  Given the mid-turn requirement, **Phase 2 below implements MCP filtering as
  (1) only**, and documents (2) as a follow-up if per-server (not just
  per-gateway-tool) granularity turns out to matter.

## 3. New module: the Jev client

`src/lib/pi/runtime/jev-client.ts` (new file, alongside `cheap-model.ts` which
it is a sibling of conceptually — "which inexpensive model answers a narrow
typed question", just a different endpoint and response shape):

```ts
export interface JevQuestion {
  type: "noul" | "choice" | "score";
  instructions: string;
  criteria: Record<string, string> | string[];
}

export interface JevDecisionRequest {
  state: string | object | unknown[];
  questions: Record<string, JevQuestion>;
}

export type JevAnswer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; probabilities: Record<string, number> }
  | { type: "score"; score: number };

export async function askJev(
  request: JevDecisionRequest,
  opts?: { apiKey?: string; timeoutMs?: number },
): Promise<Record<string, JevAnswer>>;
```

- Reads the OpenRouter key via `readOpenRouterKey()` (`code-index/credentials.ts`
  already establishes this is where every OpenRouter-backed capability in
  Semla gets its key from — no second credential source).
- `fetch`-based, `AbortSignal`-backed timeout (mirrors `embed.ts`'s direct-fetch
  pattern rather than going through `ModelRegistry`, since the Decisions API
  is not a chat completion).
- Throws a typed error on non-2xx / timeout / malformed JSON; callers decide
  fail-open vs fail-closed — this client itself makes no availability
  decision.
- No retry logic beyond what the caller wants; this is a single narrow HTTP
  call, not a streaming completion.

**Verification for this phase:** a contract test that mocks `fetch` and
asserts the request shape (`model`, `state`, `questions`) and response
parsing for all three answer types, plus a manual probe script (comment,
not run in CI) recording one real call's shape — following the same
"established by probing, not by documentation" discipline `embed.ts` and
`credentials.ts` already use for OpenRouter endpoints undocumented in
`/api/v1/models`.

## 4. New extension: `jev-gate`

`src/lib/pi/extensions/jev-gate.ts` (new path extension, registered in
`extension-manifest.ts` like `read-router.ts`).

**Inputs to one Jev call, batched into a single `questions` object per
evaluation** (one HTTP round trip, not one per tool):
- `state`: the user's current prompt text plus a compact manifest of what
  could be offered — every candidate tool name + one-line description, every
  candidate skill name + description, and `mcp`/`mcpScript` availability.
  Modeled on the same discipline `read-router.ts`'s `COMPRESSION_SYSTEM_PROMPT`
  used: the model only sees what it's asked about, not the whole session.
- `questions`: one `choice` question whose `criteria` are the candidate tool
  names ("which tools does this turn need"), one `choice` question over
  skill names, and one `noul` question ("does this turn need MCP/browser
  capability"). Multi-select is not natively expressed by Jev's `choice` type
  (single pick + distribution) — so **relevance is read from the returned
  `probabilities` map, not just the top `choice`**, with a configurable
  threshold (e.g. keep any tool/skill whose probability clears 0.15) rather
  than keeping only the single winner. This needs validating against a real
  response before being trusted (see §3's contract test) since it is inferred
  from the FAQ-less parts of the page, not documented behavior.

**Wiring:**
- `turn_start` handler: runs the Jev call, then calls
  `pi.setActiveTools([...alwaysOnTools, ...jevApprovedTools])` — mirrors
  `workflow.ts`'s existing use of `setActiveTools`. `alwaysOnTools` is a fixed
  floor (`read`, `ask_user`, at minimum) that Jev can never remove, so a
  degenerate answer cannot leave the agent unable to even read a file or ask
  a clarifying question.
- `tool_result` handler (same event `read-router.ts` already listens on):
  re-runs the same decision when the conversation has moved meaningfully
  since the last check (content-hash-gated, same caching idea `read-router.ts`
  uses, to avoid a Jev call after every single tool call).
- `before_agent_start` handler: rebuilds `systemPrompt` with only the
  Jev-approved skill blocks, using `systemPromptOptions` to know what was
  assembled. Applied once per user prompt (§2's documented limit).
- **Fail-closed fallback:** on any `askJev` error/timeout, `jev-gate` sets
  `MINIMAL_SAFE_TOOLS` (a short, explicit constant — e.g. `read`, `bash`,
  `ask_user`, `workflow_control`) rather than leaving the prior (possibly
  fuller) set in place, and logs a warning once per session (same
  "warn once, not every call" discipline `read-router.ts` uses for its own
  fail-open case) so a broken Jev integration is visible in session logs
  rather than silently degrading every turn.
- **Settings/off-switch:** a `jevGateEnabled` (default: to be decided — likely
  `false` until validated) flag read the same way `read-router.ts` reads
  `readRouterEnabled` from `loadWorkflowSettings`, so this can ship dark and be
  turned on per-project without a code change.

**Telemetry:** emit a `jev_gate.decision` span per evaluation (state hash,
questions asked, answers received, resulting tool/skill set, and whether it
was a live decision or the fail-closed fallback) through the existing
`getSpanSink`/`createSpanPublisher` path `read-router.ts` already uses for
`read_router.compress` — traceability requires that "why did the agent not
have tool X this turn" be answerable from the span log, not just inferred.

## 5. Sequencing

1. **Client** (`jev-client.ts` + contract test) — no behavior change, dead
   code until wired in.
2. **Tool gating only** (`turn_start` + `tool_result`, fail-closed to
   `MINIMAL_SAFE_TOOLS`), behind `jevGateEnabled: false` by default. This is
   the smallest slice that is independently testable and reversible (a
   feature flag flip), and it's where the coarse MCP gating (`mcp`/
   `mcpScript` as ordinary tools, §2's option 1) lands too — no separate
   phase needed for it.
3. **Skill gating** (`before_agent_start` system-prompt rewrite). Kept
   separate from (2) because it touches prompt assembly rather than the tool
   registry, and a bug here is a silently different system prompt rather than
   a loudly missing tool — worth landing and observing independently.
4. **(Follow-up, not scheduled)** Per-server MCP filtering via rewriting
   `MCP_CONFIG_PATH` before session bind, if gateway-tool-level granularity
   from (2) proves too coarse in practice.

## 6. Open questions to settle before implementation starts

- **Threshold for "relevant".** What probability cutoff keeps a tool/skill in
  the approved set? Needs a handful of real Jev calls to calibrate — cannot
  be picked from the docs alone.
- **Latency budget.** Every `turn_start` now costs one extra HTTP round trip
  before the agent can act. Needs a timeout value and a decision on whether
  slow (but not failed) Jev responses should race against a hard deadline
  the way `read-router.ts`'s 2s latency guard does for its context-hook path.
- **`MINIMAL_SAFE_TOOLS` contents.** Needs an explicit, reviewed list — this
  plan proposes `read`, `bash`, `ask_user`, `workflow_control` as a starting
  point, but that is a judgment call for the operator, not something this
  research settled.
- **Default `jevGateEnabled`.** Ship disabled and let it be turned on
  explicitly, or default-on once phase 2 has a track record — recommend
  disabled until there's a session or two of `jev_gate.decision` spans to
  read.

## 7. What would make this verifiable once built

- Contract test in §3 asserting request/response shape against a mocked
  `fetch`.
- Unit tests for `jev-gate.ts`'s fail-closed path: force `askJev` to reject
  and assert `setActiveTools` is called with exactly `MINIMAL_SAFE_TOOLS`, not
  the previous set.
- A live smoke test (manual, like the MCP spike in `docs/plans/mcp-servers.md`
  §2) against the real `~typesafe/jev-latest` endpoint, recording the actual
  response shape for `choice`/`noul` before the threshold logic in §4 is
  trusted.
- `jev_gate.decision` spans inspectable per session, so "why doesn't this
  session have tool X" has a concrete, timestamped answer rather than
  requiring a re-run to reproduce.

## 8. Displaying Jev usage in the Conversation
- Once the above is executed, we want to show UI in the Conversation when Jev was
consulted and what it returned in terms of available skills, tools and sources to the agent.
This should be shown as an icon badge similar to the Wiki badge. When clicking on it,
a popover should show which skills, tools and sources were deemed appropriate to be used
by the agent by Jev.