# Plan: row-level slots for `react-otel-trace-waterfall`

**Goal:** add per-part customization slots (span name, span bar) to the
`react-otel-trace-waterfall` component, export its layout constants, and fix a
row-click bug — then collapse Semla's ~210-line full-row override down to the
few pieces that are genuinely app-specific.

**Status:** not started. Written 2026-08-26.

---

## 0. Before you start — you need the library source

The library is **not** in this repo. Semla consumes it as a pinned npm tarball:

```json
"react-otel-trace-waterfall": "https://registry.npmjs.org/react-otel-trace-waterfall/-/react-otel-trace-waterfall-0.7.0.tgz"
```

Its `package.json` lists `author: Coen Warmer <coen.warmer@gmail.com>`, license
CC0-1.0, and **no `repository` field** — so there is no link to follow. Ask the
user where the source checkout lives before doing anything in part A.

Only `node_modules/react-otel-trace-waterfall/dist/**/*.d.ts` is available here.
That is enough to read the current API but not to change it. Do not attempt to
patch files inside `node_modules` — they are regenerated on install.

Parts A and B are separable. **Part B (Semla-side) depends on A shipping and the
dependency being re-pinned to the new version.** If the source is unavailable,
do part C only and stop.

---

## 1. Why

To render a running span's title with a shimmer (commit `ec8ac78`), Semla had to
pass `SpanComponent` — which replaces the *entire* row. The library has slots for
the chevron (`ExpandComponent`), the leading-edge prefix (`RowPrefixComponent`),
event markers (`EventMarkerComponent`), the tooltip, the inspect panel, the fit
button and the skeleton — but **nothing for the span name or the bar**.

That is a cliff rather than a step, and the library says so itself in
`ExpandComponent`'s doc comment:

> Only applied when `SpanComponent` is NOT provided (custom span rows own their
> own expand UI).

So opting into one customization forfeits every other slot. The consequences in
Semla today, all in `src/components/session-workflow-panel.tsx`:

- `InlineSpanRow` (line 215, ~210 lines) re-implements the chevron, label
  column, bar, bar hit area, and folded event markers.
- It hand-mirrors library layout constants that are **declared but not
  exported**, under a comment admitting it ("Shared constants that mirror the
  library's internal layout values"):

  | Semla (`session-workflow-panel.tsx`) | Library (`dist/components/SpanRow.d.ts`) |
  |---|---|
  | `LABEL_COL = 280` (line 181) | `LABEL_WIDTH = 280` |
  | `SPAN_ROW_H = 32` (line 182) | `ROW_HEIGHT = 32` |
  | `BAR_H = 14` (line 183) | `BAR_HEIGHT = 14` |
  | indent via `t.rowIndentPx` | `INDENT_PX = 14` |

  Change `ROW_HEIGHT` in the library and Semla's rows silently misalign. Nothing
  fails a build or a test.

- It carries a workaround for library click behaviour (line 258):

  > The waterfall wraps this row in a div that selects on any click, which opened
  > the drawer from anywhere on the row — including empty timeline space. Swallow
  > the click here so only the bar below selects, and so our own `onSelect` is not
  > doubled by the wrapper's.

---

## Part A — library changes

### A1. `SpanNameComponent`

Replaces the span's name text inside the label column; everything else about the
row stays default. Match the existing prop naming and the shape of
`RowPrefixProps`.

```ts
/** Props passed to a custom span-name component. */
export interface SpanNameProps {
  row: FlatRow;
  span: SpanNode;
  isSelected: boolean;
}
```

On `TraceWaterfallProps`, documented in the same style as its neighbours:

```ts
/**
 * Replaces the text rendered for a span's name in the label column.
 * The row's layout, truncation and chevron are unaffected.
 * Receives `{ row, span, isSelected }`.
 */
SpanNameComponent?: React.ComponentType<SpanNameProps>;
```

Slot it where `SpanRow` renders the name today. Keep the existing wrapper element
and its `overflow/text-overflow/white-space` styles, so a custom component
inherits truncation rather than re-deriving it. **Note for the implementer:** a
component that renders an `inline-block` (as `Shimmer` does) is not truncated by
the parent's `text-overflow: ellipsis` — mention this in the prop's doc comment
so consumers add `max-w-full overflow-hidden text-ellipsis` themselves.

Default colour handling (`spanNameColor` / `spanNameErrorColor` from the theme)
should stay on the wrapper so a custom component can inherit it via `color`.

### A2. `SpanBarComponent`

The reason a name slot alone is not enough: Semla also customizes the bar. Any
consumer that wants status-driven bars hits the same cliff.

```ts
/** Props passed to a custom span-bar component. */
export interface SpanBarProps {
  row: FlatRow;
  span: SpanNode;
  /** Left offset in px from the start of the time axis. */
  x: number;
  /** Bar width in px, already clamped to the minimum. */
  width: number;
  isSelected: boolean;
}

/**
 * Replaces the bar drawn in the timeline column.
 * Rendered inside the same absolutely-positioned wrapper as the default bar.
 * Receives `{ row, span, x, width, isSelected }`.
 */
SpanBarComponent?: React.ComponentType<SpanBarProps>;
```

Keep the library owning the positioning wrapper and the click/hit area, so a
consumer overriding the bar does not also have to re-implement aiming at narrow
bars. If the built-in hit padding is not already configurable, expose it as a
theme token (e.g. `barHitPaddingPx`) rather than making each consumer rebuild the
hit area — that is the specific thing that forced Semla's `BAR_HIT_PAD = 4`.

Both new props must compose with `ExpandComponent` and `RowPrefixComponent` —
i.e. they must **not** inherit `SpanComponent`'s all-or-nothing exclusion.

### A3. Export the layout constants

`ROW_HEIGHT`, `LABEL_WIDTH`, `INDENT_PX` and `BAR_HEIGHT` are declared in
`dist/components/SpanRow.d.ts` but absent from `dist/index.d.ts`. Add them to the
public export in `index.ts`. One line; removes a whole class of silent drift for
any consumer still using `SpanComponent`.

### A4. Fix row-click selection

Clicking anywhere on a row — including empty timeline space to the right of the
bar — currently selects the span, because the wrapper div handles the click.
Selection should originate from the bar (and its hit padding) only.

Fixing this upstream lets Semla drop the `onClick={(e) => e.stopPropagation()}`
workaround at `session-workflow-panel.tsx:258`.

**This is a behaviour change**, so decide deliberately: either treat it as a fix
in a minor version, or gate it behind a prop (e.g. `selectOnRowClick`, defaulting
to the new behaviour). Note it in the changelog either way.

### A5. Release

Bump the version, publish, and re-pin Semla's `package.json` to the new tarball
(or, better, to a semver range now that a second version exists).

---

## Part B — Semla-side simplification

**Do not start until A has shipped and the dependency is re-pinned.**

In `src/components/session-workflow-panel.tsx`:

1. Replace `SpanComponent={InlineSpanRow}` (line 971) with the composed slots:
   `SpanNameComponent`, `SpanBarComponent`, `ExpandComponent` (if the default
   chevron is not wanted), and `EventMarkerComponent`.
2. Extract from `InlineSpanRow` and keep only what is genuinely app-specific:
   - **Name:** the `Shimmer` for `isRunning && !isError`, including the
     `--color-muted-foreground` / `--color-background` overrides that restate
     Shimmer's colours in the waterfall palette (the panel is pinned to
     `darkTheme` while Shimmer's defaults follow the app theme — see the comment
     at line ~299; keep it).
   - **Bar:** the running gradient, the 8px transparent queued marker, and the
     status-driven `paletteColor` / `barErrorColor` choice.
   - The spinner and queued `·` that currently sit *after* the label. These fit
     neither `RowPrefixComponent` (leading edge, before the label column) nor
     cleanly inside `SpanNameComponent`. Either fold them into the name component
     or ask for a trailing-suffix slot in A. **Resolve this before starting B** —
     it may add a third prop to part A.
3. Delete `LABEL_COL`, `SPAN_ROW_H`, `BAR_H`, `BAR_HIT_PAD` (lines 181–186) and
   import the library's constants where still needed. `MIN_BAR_W` may also become
   the library's concern — check.
4. Delete the `e.stopPropagation()` workaround at line 258 once A4 ships, and
   verify clicking empty timeline space no longer opens the drawer.
5. `SHIMMER_STYLE` (line 172) defines `@keyframes span-shimmer`, which drives the
   running **bar** gradient at line 377 — it is not related to the title's
   `Shimmer` component and is still needed. It must move into whatever renders
   the bar (`SpanBarComponent`), not be deleted. Note it is currently injected as
   a `<style>` tag on every row render; folding it into the library's own styles
   would be better still.

---

## Part C — if the library source is unavailable

Do this instead, entirely within Semla, and skip A and B:

- Add a test asserting Semla's mirrored constants still match the library's, so
  drift fails loudly instead of silently. Read them from
  `node_modules/react-otel-trace-waterfall/dist/components/SpanRow.d.ts` (they are
  `export declare const` lines) or from the runtime module if they are reachable.
  This is a stopgap, not a fix — say so in the test's comment.

---

## Validation

Semla's usual gates (`AGENTS.md`): `npx tsc --noEmit`, `npm run lint`,
`npm test`. Note lint currently reports ~84 pre-existing errors across
`ai-elements/` and `ui/` — compare against the baseline on `main` rather than
expecting zero. Also run `npm run build`.

For the library: its own `npm run build` (`tsc --noEmit && vite build`) and
`npm run test:run`. It ships Storybook — add stories for the new slots.

**This work is almost entirely visual, and none of Semla's 87 tests cover row
rendering.** Type checks and unit tests will not catch a misaligned row or an
invisible label. Verify in the browser against a live session with a running
workflow, in both light and dark app themes (the panel is always dark, so a
regression here shows up as unreadable text in light mode specifically). Check:

- a running agent row — shimmering title, animated bar, spinner
- a queued agent row — the 8px marker and `·`
- an errored row — static red title, error-coloured bar
- a long span name — truncates with an ellipsis rather than clipping
- clicking empty timeline space — must not open the drawer
- clicking a narrow bar — must still be aimable

---

## Non-goals

- Rewriting the timeline's data pipeline (`src/lib/workflow-spans.ts`) — this is
  purely about row rendering.
- Changing which spans are shown, or the `foldEventsIntoParent` behaviour.
- Removing the spinner from running rows. It is arguably redundant now that the
  title shimmers and the bar animates, but that is a product call the user has
  not made.
