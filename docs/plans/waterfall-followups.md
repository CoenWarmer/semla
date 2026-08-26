# Plan: follow-up ergonomics for `react-otel-trace-waterfall`

**Goal:** remove the remaining friction between the waterfall component and
Semla, now that 0.8.0's row slots have landed.

**Status:** not started. Written 2026-08-26.
**Predecessor:** `docs/plans/waterfall-row-slots.md` — parts A1/A2/A3 shipped in
0.8.0 and Semla's port landed in commit `0e10a6e`, which deleted `InlineSpanRow`
(−206 lines). Read that document first for repo context; **§0 there (you need
the library source, it is not in this repo) applies here unchanged.**

Each item below is independent. Ship them in any order, or cherry-pick.

---

## What 0.8.0 settled, and what it didn't

Shipped and confirmed in `dist/`: `SpanNameComponent`, `SpanBarComponent`, the
`barHitPaddingPx` theme token, and the `ROW_HEIGHT` / `LABEL_WIDTH` /
`INDENT_PX` / `BAR_HEIGHT` exports.

Two corrections to the predecessor plan, so nobody re-litigates them:

- **A3 (export the layout constants) turned out to be unnecessary for Semla.**
  Once the row was no longer overridden there was nothing left to mirror, and
  `ROW_HEIGHT` would have collided with a same-named local constant in Semla's
  graph view. Keep the export for other consumers; it is not load-bearing here.
- **A4 (row-click selection) did not ship**, and no longer needs to. The wrapper
  `onClick` survives on the *custom row* path, now documented in the source as
  deliberate ("ensures selection works even if the custom component doesn't call
  `onSelect` itself"). Built-in rows select only from the label column and the
  bar, so moving off `SpanComponent` resolved the symptom. **Do not "fix" this** —
  removing it would break consumers still passing `SpanComponent`.

---

## 1. Make synthesised spans cheap to build  ← highest value

**Problem.** `OtelSpan` is shaped for *ingesting* real OTel data. Semla
*synthesises* spans from app state, and `src/lib/workflow-spans.ts` (383 lines)
pays a fixed tax for it, all in the first 27 lines:

```ts
function msToNano(ms: number): string {
  // Multiply milliseconds by 1,000,000 using string math to avoid BigInt
  // (tsconfig target < ES2020).
  const whole = Math.round(ms);
  return `${whole}000000`;
}

// Deterministic 16-char hex span ID from a string key.  (djb2, two rounds)
function makeSpanId(key: string): string { /* ~10 lines */ }

// Fixed trace ID — all synthesized spans belong to one trace per page load.
const TRACE_ID = "73656d6c61736573730000000000006f";
```

`msToNano` is called ~15 times across the file. Every consumer that builds spans
rather than receiving them writes these same three things, and the BigInt
constraint is a real one — Semla targets ES2017.

**Change.** Accept millisecond timings as an alternative to the nano strings,
and export the ID helper.

```ts
export interface OtelSpan {
  // …existing fields…
  /** Nanoseconds since Unix epoch as a decimal string (OTel int64 convention). */
  startTimeUnixNano?: string;
  endTimeUnixNano?: string;
  /**
   * Milliseconds since Unix epoch. Convenience alternative to the *UnixNano
   * fields for synthesised spans. When both are present, the nano fields win.
   */
  startTimeMs?: number;
  endTimeMs?: number;
}

/**
 * Deterministic 16-char hex span ID derived from a stable key, for callers
 * synthesising spans that have no real trace backing them. The same key always
 * yields the same ID, so React keys and selection survive re-renders.
 */
export function makeSpanId(key: string): string;

/** Deterministic 32-char hex trace ID from a stable key. */
export function makeTraceId(key: string): string;
```

Normalise to nanoseconds once at ingest (in `buildSpanTree` or just before it)
so nothing downstream changes. Type it so that at least one of each pair is
required — a union of two variants is friendlier than four optional fields:

```ts
type SpanTiming =
  | { startTimeUnixNano: string; endTimeUnixNano: string }
  | { startTimeMs: number; endTimeMs: number };
```

**Watch out:** millisecond precision is lossy for real sub-millisecond traces.
This is explicitly a convenience for synthesised data — say so in the doc
comment, and keep the nano fields as the canonical form. Do **not** convert
existing nano input through a lossy path.

**Semla follow-up:** delete `msToNano`, `makeSpanId` and `TRACE_ID` from
`src/lib/workflow-spans.ts`; switch the ~15 call sites to `startTimeMs` /
`endTimeMs`. Its tests (`src/lib/workflow-spans.test.ts`, 12 tests) read
timestamps back via `Number(nano.slice(0, -6))`, defined locally in three
separate tests — update all three.

---

## 2. Let the inspect panel escape its container

**Problem.** Semla cannot use the built-in detail panel. From
`src/components/session-workflow-panel.tsx:918`:

> We render our own panel below, so switch the built-in one off rather than
> showing both. Ours also portals to the body, which the 260px overflow-auto
> inspect container would otherwise clip.

So Semla passes `disableInspectPanel`, renders its own `SpanDetailDrawer`, and
keeps a `selectedSpan` state plus toggle logic in parallel with the library's own
selection state — two sources of truth for the same thing.

**Change.** Render the inspect panel through a portal, or accept a target:

```ts
/**
 * Where to render the span detail panel. Defaults to inline, inside the
 * waterfall's own container. Pass an element (or `document.body`) to portal it
 * out — useful when the waterfall lives in a small scrolling container that
 * would otherwise clip the panel.
 */
inspectPanelContainer?: HTMLElement | null;
```

Portalling by default would be the cleaner API but is a behaviour change for
existing consumers; the opt-in prop is the safer call.

**Semla follow-up:** drop `disableInspectPanel`, pass the existing
`SpanDetailDrawer` as `SpanInspectComponent` with
`inspectPanelContainer={document.body}`, and delete the local `selectedSpan`
state and the toggle branch in `onSelectSpan`. Keep the agent-row special case
(agent spans open the transcript drawer instead).

---

## 3. Folded event markers ignore ERROR status  ← a bug

**Problem.** `SpanRow` derives a status-aware colour and uses it for the bar and
for standalone EVENT markers:

```js
const isError = span.status?.code === "ERROR";
const color = isError ? theme.barErrorColor : paletteColor(service, theme.barPalette);
// standalone EVENT marker: barColor: theme.eventMarkerColor || color
```

But the folded-markers loop (`(row.events ?? []).map(...)`, the
`foldEventsIntoParent` path) recomputes it **without** the status check:

```js
const color = theme.eventMarkerColor || paletteColor(service, theme.barPalette);
```

So a failed tool call folded onto a parent row renders in its service colour
instead of the error colour, while the identical span on its own row renders red.

**Change.** Use the same status-aware derivation in both paths. Factor it into
one helper so they cannot drift again.

**Semla follow-up:** this is the *only* reason Semla passes
`EventMarkerComponent` (see `EventMarker` at `session-workflow-panel.tsx:352`,
which reimplements the library's colour logic purely to add the error case).
Delete the component and the prop once this ships.

---

## 4. A way to reset row state without remounting

**Problem.** Semla forces a full remount whenever the run changes
(`session-workflow-panel.tsx:896`):

```tsx
key={`${sessionId ?? ""}-${snapshot.runId ?? "no-run"}`}
```

`initialState="expanded"` only applies at mount, and expansion state is internal,
so a new run would otherwise inherit the previous run's collapsed/expanded rows.
The remount also discards scroll position, zoom, and live-mode state, and
re-runs the entry animation for every row.

**Change.** Either a declarative reset key:

```ts
/**
 * Change this to re-apply `initialState` and clear per-row state (expansion,
 * selection, focus) without remounting — e.g. when switching to a different
 * trace in the same view.
 */
resetKey?: string | number;
```

…or an imperative handle (`ref` with `expandAll()` / `collapseAll()` / `fit()` /
`reset()`). The reset key is the smaller change and covers Semla's case; the
handle is more general. Pick one, not both.

**Semla follow-up:** replace the `key` prop with `resetKey`.

---

## 5. Make the span-name font size themeable

**Problem.** The label span hardcodes `fontSize: 12` with no theme token.
**Semla's row labels silently changed from 13px to 12px in commit `0e10a6e`**,
because that styling moved from Semla's deleted row into the library. Nobody has
decided whether 12 or 13 is right — it changed as a side effect.

**Change.** Add `spanNameFontSize: number` to `ThemeTokens`, defaulting to 12 so
current rendering is unchanged.

**Semla follow-up:** decide 12 vs 13 by looking at it, and set the token if 13
wins.

---

## 6. Typed attribute access (small)

**Problem.** `AttributeValue` is `string | number | boolean`, so every read needs
a cast. Semla has 9 of them, e.g.:

```ts
span.attributes?.["pi.status"] as string | undefined
span.resource?.["service.name"] as string | undefined
```

**Change.** Export narrow accessors:

```ts
export function stringAttr(span: SpanNode, key: string): string | undefined;
export function numberAttr(span: SpanNode, key: string): number | undefined;
```

Low value, near-zero risk. Do it last, or skip it.

---

## Validation

**Library:** `npm run build` (`tsc --noEmit && vite build`) and
`npm run test:run`. Add Storybook stories for anything with a visual result —
in particular a folded-marker story containing an ERROR event (item 3), which is
what would have caught that bug.

**Semla:** `npx tsc --noEmit`, `npm run lint`, `npm test`, `npm run build`.
Lint reports ~84 pre-existing errors in `ai-elements/` and `ui/` — compare
against the baseline on `main`, not against zero.

**None of Semla's 87 tests render a row.** Type checks will not catch a
misaligned bar or an unreadable label. Verify in the browser on a session with a
running workflow, in **both light and dark app themes** — the panel is pinned to
`darkTheme` while some styles derive from app-theme CSS variables, so light mode
is where a colour regression hides.

Check specifically, per item:

- **1** — spans still land at the right positions; the trace bounds are unchanged.
- **2** — the panel opens above the timeline and is not clipped by the 240px-high
  scroll container.
- **3** — a failed tool call's marker is red, both folded and unfolded.
- **4** — switching runs resets expansion but keeps scroll position.
- **5** — label text at the intended size.

Also worth an eye regardless, since `0e10a6e` changed them and nobody has looked
yet: the library draws a 1px guide line at each bar's start that Semla's old row
did not, and the queued marker's hit area shrank from ~16px to ~10px.

---

## Non-goals

- Reverting or re-fixing the custom-row wrapper `onClick` (see the corrections
  above).
- Touching Semla's span *content* — which spans exist, the hierarchy, or
  `foldEventsIntoParent`. This is about the input format and the row chrome.
- Removing the spinner from running rows. It may be redundant now that the name
  shimmers and the bar animates, but that is the user's call and they have not
  made it.
