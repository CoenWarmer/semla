/**
 * Whether a blank line sits inside an open JSX attribute list.
 *
 * This exists for one case Monaco will not trigger on by itself:
 *
 * ```tsx
 * <SessionProjectPicker
 *   linkedPaths={new Set(projects.map((project) => project.path))}
 *   sessionId={sessionId}
 *   ⟵ here
 * />
 * ```
 *
 * `SuggestModel.shouldAutoTrigger` requires `getWordAtPosition` to return a
 * word, and a whitespace-only line has none — so it returns false before the
 * `quickSuggestions` option is even read, and the provider is never asked.
 * The language server, meanwhile, answers that exact position perfectly well:
 * it returns the tag's *remaining* props, with the ones already written
 * excluded. So the gap is the trigger, not the answer.
 *
 * **Why a text scan rather than the language server.** This runs on cursor
 * movement, so asking the server would be a round trip every time the caret
 * lands on a blank line. What makes a scan good enough is
 * `suggestWidget.js`'s own behaviour on an empty result:
 *
 * ```js
 * this._setState(isAuto ? State.Hidden : State.Empty);
 * ```
 *
 * An `auto: true` trigger with nothing to show hides silently, where an
 * explicit one says "No suggestions.". Since the caller triggers with
 * `auto: true`, a false positive costs one wasted request and displays
 * nothing — so this is allowed to be approximate in the permissive direction,
 * and is written to be conservative in the other. It never decides what to
 * *insert*; it only decides whether to ask.
 *
 * **What it deliberately does not do.** No brace tracking, no string or
 * comment awareness beyond the cheap checks below, no JSX parse. A prop value
 * spanning several lines (`linkedPaths={new Set(...)}` broken across three)
 * is why the scan looks for the opening tag rather than trying to read the
 * line above: the line above is frequently a fragment of an expression.
 */

/** How many lines back to look for the opening tag. */
const MAX_LOOKBACK = 40;

/** `<Name`, `<Name.Sub`, `<ns:name` — the start of an element, captured. */
const OPEN_TAG = /<([A-Za-z_$][\w$]*(?:[.:][A-Za-z_$][\w$]*)*)/;

/**
 * A line that closes whatever tag was open, so anything above it is a
 * different element: `/>`, `>` at the end, or a closing `</Name>`.
 */
const CLOSES_TAG = /(\/>|>\s*$|<\/)/;

export type JsxAttributeProbe = {
  /** The line the cursor is on, zero-based into `lines`. */
  line: number;
  lines: readonly string[];
};

/**
 * True when the cursor's line is blank and the nearest enclosing JSX tag is
 * still open — i.e. the cursor is where another attribute would go.
 */
export function isInsideOpenJsxTag({ line, lines }: JsxAttributeProbe): boolean {
  const current = lines[line];
  if (current === undefined) return false;

  // Only a blank line. Anywhere there is a word, Monaco triggers on its own
  // and this must not add a second trigger for the same keystroke.
  if (current.trim() !== "") return false;

  const start = Math.max(0, line - MAX_LOOKBACK);
  for (let index = line - 1; index >= start; index -= 1) {
    const text = lines[index];
    const trimmed = text.trim();

    // A blank line between attributes is unusual but harmless; keep looking.
    if (trimmed === "") continue;

    /*
     * A line comment is skipped rather than treated as a boundary: `//
     * TODO: pass a className` between attributes is real, and it says nothing
     * about whether the tag is open. Block comments are not tracked at all —
     * see the docblock on why approximate-and-permissive is the safe
     * direction here.
     */
    if (trimmed.startsWith("//")) continue;
    if (trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;

    const open = OPEN_TAG.exec(text);
    const closes = CLOSES_TAG.test(text);

    /*
     * Order matters. A line can both open and close — `<Foo bar={1} />` — and
     * that tag is finished, so the cursor below it is not in an attribute
     * list. Checking `open` first would claim it.
     *
     * The exception is a line that opens a tag *after* it closes a previous
     * one, `/> <Bar` — vanishingly rare in formatted code and not worth the
     * ambiguity, so it is read as closed and the scan stops.
     */
    if (closes) return false;
    if (open) {
      /*
       * A lone `<` with no name is a comparison or a generic, not a tag. The
       * regex requires a name, so reaching here means a real element name was
       * matched — but it may still be the *tail* of an expression like
       * `a < b`, which is why the name must start at a word boundary that is
       * not preceded by an identifier character.
       */
      const before = text.slice(0, open.index);
      if (/[\w$)\]]\s*$/.test(before)) return false;
      return true;
    }
  }

  return false;
}
