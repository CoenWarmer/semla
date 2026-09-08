# Tool result compression

## Problem

Every `bash` and `read` result goes directly into the frontier model's context
window. In a typical investigative session, 174 bash calls and 18 read calls
accumulated 311 KB of raw tool output in the main context, growing it to 215 K
tokens. Each subsequent turn paid cache-read cost against that entire history.
The most expensive session analysed cost $10.38 over 100 minutes — 55% of that
was cache reads, and most of the cache was raw grep output and file contents the
model had already moved past.

The Portal by Spotify team solved the same problem with Claude Code hooks: they
intercept `read` calls above a line threshold and redirect the content through a
cheap worker model (Gemini Flash), which returns a structured summary. Their
reported savings: 90% token reduction on a Java monorepo.

Semla has a native equivalent. Pi's `tool_result` extension event fires after
every tool executes, before the result enters the context, and its handler can
return a replacement `content` array. Handlers are async, so a summarisation
API call is legal. The frontier model never sees the raw output — only the
summary.

---

## Approach

Add a `read-router` extension that intercepts large `bash`, `read`, `grep`, and
`find` results and runs them through a cheap model. The replacement lands in the
context in place of the raw output. No behaviour change is required from the
frontier model; the compression is transparent.

A second, complementary hook — the `context` event — fires before every LLM
call and can rewrite the full message history. This handles retroactive
compression: messages that entered context before the extension was active (e.g.
after a `/resume` or when the extension is first enabled mid-session) can be
compressed on the next turn.

---

## Extension API surface

Both hooks are already in Pi's `ExtensionAPI`:

```ts
// Fires after a tool executes. Return { content } to replace the result.
pi.on("tool_result", async (event, ctx): Promise<ToolResultEventResult> => { … });

// Fires before every LLM call. Return { messages } to rewrite the context.
pi.on("context", async (event, ctx): Promise<ContextEventResult> => { … });
```

`ExtensionHandler<E, R>` is typed as `Promise<R | void> | R | void`, so async
is fully supported.

The existing `install-guard` extension (which blocks bash calls in
`tool_call`) is the pattern to follow for a factory extension with a single
responsibility.

---

## Implementation plan

### Phase 1 — `tool_result` interception

**New file:** `src/lib/pi/extensions/read-router.ts`

```ts
import type { ExtensionAPI, ToolResultEventResult } from "@earendil-works/pi-coding-agent";

export default function readRouterExtension(pi: ExtensionAPI) {
  pi.on("tool_result", async (event): Promise<ToolResultEventResult | void> => {
    if (!shouldCompress(event)) return;
    const summary = await summarise(event);
    return { content: [{ type: "text", text: summary }] };
  });
}
```

**`shouldCompress` — threshold logic:**

| Tool | Threshold | Rationale |
|------|-----------|-----------|
| `read` | > 300 lines | ~4 KB; a file the model will not edit inline |
| `bash` | output > 3 000 chars | Grep with many results, `cat` of a large file |
| `grep` | > 40 matches | One match per line; 40 lines is ~1 500 chars |
| `find` | > 40 results | Same |
| `ls` | > 80 entries | Unlikely; directory listings are usually short |
| `edit`, `write` | never | These need exact content to confirm the change |

For `read`, also skip compression when the calling turn contains an `edit` or
`write` call for the same path (the model needs the raw content to produce a
correct diff).

**`summarise` — cheap model API call:**

The system prompt for the summarisation model:

> You are a precise code analyst. Given file content or command output, answer
> the attached question concisely. Return only facts — no preamble, no
> "certainly", no repetition of the question. If the content is a code file,
> include: the file's purpose (one sentence), its public exports and their
> signatures, and any non-obvious invariants. If the content is command output,
> extract only the lines or values relevant to the question.

The question is derived from the frontier model's last assistant text (the
reasoning that led to this tool call). If that is unavailable, fall back to a
generic summary prompt.

Model: `anthropic/claude-haiku-4-5` (or `google/gemini-flash-2.0` as an
alternative). Configurable via `readRouterModel` in workflow settings (see
Phase 3).

The compressed result should prepend a one-line header so the frontier model
knows what happened:

```
[Compressed: 847 lines → 312 tokens via read-router]

<summary here>
```

**Add to manifest** (`src/lib/pi/extensions/extension-manifest.ts`):

```ts
{
  id: "read-router",
  source: { factory: readRouterExtension, kind: "factory" },
  requires: [],
  providesTools: [],
  optionalTools: [],
  providesSlots: [],
  remedy: "This extension is imported directly; a failure here is a code problem in src/lib/pi/extensions/read-router.ts.",
},
```

Add `"read-router"` to the `ExtensionId` union.

The extension has no `requires` and no `providesTools`, so load order and the
coherence check require no changes.

---

### Phase 2 — `context` event retroactive compression

Add a second handler in the same extension that scans the full message history
before each LLM call and compresses any tool result messages that exceed the
threshold but were not caught by Phase 1 (pre-existing history, resumed
sessions).

```ts
pi.on("context", async (event): Promise<ContextEventResult | void> => {
  const compressed = await compressLargeToolResults(event.messages);
  if (!compressed) return; // nothing changed
  return { messages: compressed };
});
```

`compressLargeToolResults` walks `event.messages`, finds `tool_result` content
blocks over threshold, batches the compressions (parallel API calls), and
returns the rewritten message array. It should cache by content hash so the
same large result is not re-compressed on every turn.

**Latency guard:** if the context scan + compression takes > 2 s, return early
with no replacement. The uncompressed history is better than a delayed turn.

---

### Phase 3 — configuration

Add `readRouterModel` and `readRouterEnabled` to `WorkflowSettings`:

```ts
interface WorkflowSettings {
  // … existing fields …
  readRouterEnabled?: boolean;   // default true
  readRouterModel?: string;      // default "anthropic/claude-haiku-4-5"
  readRouterThresholdLines?: number;  // default 300
  readRouterThresholdChars?: number;  // default 3000
}
```

These follow the same pattern as `defaultTokenBudget` and
`defaultAgentTimeoutMs`.

---

### Phase 4 — observability

The extension should emit a span for each compression:

```ts
{
  name: "read_router.compress",
  attributes: {
    tool: event.toolName,
    originalChars: rawContent.length,
    compressedChars: summary.length,
    ratio: summary.length / rawContent.length,
    model: readRouterModel,
  }
}
```

This lands in the existing `.spans.jsonl` alongside the session, so the cost
analysis tooling can report compression ratios per session without any new
infrastructure.

A session-level summary should be emitted at `session_shutdown`:
total compressions, original chars, compressed chars, estimated token savings.

---

## What this does not cover

**Editing context.** The model needs the full content of a file it is about to
edit. The `shouldCompress` gate skips `edit`/`write` calls in the same batch,
but the heuristic is approximate — a model that reads a file "just to
understand" and then edits it two tool calls later will get the compressed
version for the first read. The edit will still work because `edit` sees the
live file on disk, not the compressed version in context. The only failure mode
is if the model tries to reproduce exact line numbers from its compressed read
memory — which is uncommon and self-correcting (the next `read` or `edit`
error will prompt a fresh read).

**bash commands that produce output the model acts on verbatim.** A `bash git
log --oneline` result that the model parses line-by-line should not be
compressed. The threshold heuristic catches most of these (git log output is
usually short), but a long log will be summarised. This is acceptable: the
model should use structured tools (`git_status`, `code_find`) for queries it
acts on, not parse raw `bash` output.

**Subagent tool results.** The `tool_result` hook in the main session fires
for main-session tool calls only. Subagent sessions are separate Pi instances;
they would need their own `read-router` extension. The workflow extension's
`toolsets` mechanism controls what a subagent gets, but extension injection into
subagents is not currently exposed. This is a follow-up if subagent context also
becomes expensive.

---

## Complementary approach: research agentType

Mechanical compression addresses the symptom (large results in context). The
system prompt changes tried earlier address the cause (too many inline tool
calls). The `agentType` mechanism in the workflow tool is a third lever:
pre-register a "research" agent type with Haiku as its bound model and
`read`/`bash`/`grep`/`find` as its tools. The system prompt can then reliably
point the frontier model at a specific name rather than asking it to write a
workflow script.

```ts
// In workflow settings or a project .workflow-settings.json
{
  "agentTypes": {
    "research": {
      "model": "anthropic/claude-haiku-4-5",
      "tools": ["bash", "read", "grep", "find", "code_find", "code_resolve"],
      "role": "You are a precise code analyst. Search the codebase and answer the given question concisely. Return a structured summary of findings — file paths, relevant code, and a one-paragraph conclusion. Do not implement anything."
    }
  }
}
```

System prompt addition:
> When you need to investigate code, call `workflow` with
> `agentType: "research"` and your question as the agent prompt. The research
> agent runs on a cheap fast model and returns a structured summary.

This makes the delegation explicit and cheap, rather than relying on the
frontier model to resist the urge to grep inline. It complements Phase 1–2 (the
mechanical compression catches anything that slips through).

---

## Expected savings

Based on the $10.38 session analysed:

| Driver | Current | With compression | Saving |
|--------|---------|-----------------|--------|
| Cache reads (215 K ctx × 231 turns) | $5.71 | ~$0.85 (30 K ctx) | ~$4.86 |
| Cache writes | $2.32 | ~$0.35 | ~$1.97 |
| Summarisation cost (Haiku) | — | ~$0.05 | — |
| Reasoning | $2.55 | $2.55 (unchanged) | — |
| **Total** | **$10.38** | **~$3.80** | **~$6.50 (63%)** |

The context estimate assumes compression reduces large tool results from an
average of ~1 400 chars to ~300 chars, dropping the steady-state context from
215 K to ~45 K tokens. Cache read savings are proportional.

The reasoning cost is unchanged by this approach — that requires the separate
"reasoning budget" system prompt instruction or a thinking-level cap on the
session.
