# Runtime authoring

Use this page for routine scripts. Open the generated capability index only when a signature, default, support boundary, or installed-version fact is missing here.

## Script envelope

Start with the only legal export: `export const meta = { name, description, phases?: [{ title, tier, detail?, model? }] }`. Values are nonblank literals; declare only used phases, give every one a `tier`, and call `phase()` before each phase's work. A phase with no tier, or an unknown tier name, is rejected at parse time before any agent runs. The remaining body already runs inside an async function: write helpers as ordinary declarations; `export default` and other exports are invalid. Return the result explicitly.

The runtime supplies `agent`, `parallel`, `pipeline`, `workflow`, quality/control helpers, `phase`, `log`, `args`, `cwd`, restricted `process.cwd()`, and `budget`. Imports, `require()`, filesystem modules, `Date.now()`, `Math.random()`, and no-argument `new Date()` are unavailable. The Node VM realm is implementation substrate, not a security boundary or public API.

## Topology

- `parallel()` takes thunks, runs independent work, and preserves input order. Await the whole array before whole-set synthesis.
- `pipeline()` runs stages sequentially per item while items proceed concurrently. Each stage receives `(previousValue, originalItem, index)` and forwards `null` to the next stage, so guard missing coverage first.
- `workflow(name, childArgs?)` runs a context-supplied saved workflow. Nesting is one level and shares limits, counters, tokens, and store.

## Data and failure

Call `agent(prompt, { label, schema? })`; it returns text, a schema-validated value, or recoverable `null`. Nonrecoverable limit, validation, and budget failures throw. Record each intended work ID before filtering. A `null` means missing coverage, never a negative finding.

When JavaScript reads fields, pass a small plain JSON Schema. Schema noncompliance after repair throws and bypasses agent retries. Catch it only to return an explicit incomplete outcome without reading missing fields. Return objects, arrays, strings, numbers, booleans, and `null`—not functions, promises, cycles, `BigInt`, or runtime handles.

## Routing and support

Selector priority is the declared tier of the phase the agent runs in, then — only for an agent outside any phase — that call's own explicit `tier`, which is mandatory there. A phase tier is not overridable: a `tier`, `model`, `agentType` model, or phase/metadata model route on a call inside a phase is displaced and the override is logged into the run naming the phase, the agent, the ignored value, and the winning tier. Put an agent that needs a different model in its own phase. An unavailable tier throws instead of falling back — catch it if the script needs to degrade gracefully. Use exact `model`, nonstandard `tier`, or `agentType` only when context supplies its name and purpose. Worktree isolation is best-effort. See [registry ownership](registry-ownership.md).

Generated entries marked `supported` are authoring API. `console` and whole-script Markdown fences are compatibility-only. VM realm facilities are internal. Active model routes and agent types are dynamic. Use `log()` in new scripts.
