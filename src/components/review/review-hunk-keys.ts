/**
 * Which key means which review action, and when a keypress is not one.
 *
 * Split from the listener that installs it so the whole decision is testable
 * without a DOM: what arrives here is a plain description of a keydown, and
 * what comes back is an action or null. The repository has four ad-hoc
 * `addEventListener` blocks already, and the thing they all get wrong is
 * *suppression* — a single letter is a review command only when it is not
 * being typed into something.
 *
 * Three suppression rules, each for a concrete surface in this panel:
 *
 *  - **modifiers.** `Cmd+S` is save and `Cmd+D` is the browser's; only a bare
 *    key is a review command. Shift is allowed through as the same key.
 *  - **editable targets.** The commit message input is in this panel, and
 *    `s` in it must be the letter `s`. Covers `input`, `textarea`, `select`
 *    and anything `contenteditable`.
 *  - **Monaco.** The editor pane owns the middle of the panel, and while it
 *    has focus the operator is editing a file, not reviewing hunks. Monaco's
 *    own textarea is `contenteditable`-adjacent rather than a plain input, so
 *    it is recognised by its ancestor `.monaco-editor` instead — which is also
 *    what `spec`'s "when the monaco editor does not have focus" names.
 */

export type ReviewHunkAction =
  | "next-hunk"
  | "previous-hunk"
  | "next-file"
  | "previous-file"
  | "apply-hunk";

/** The keydown facts this decision needs. Not a `KeyboardEvent`, so a test
 * does not have to synthesise one. */
export interface ReviewKeyEvent {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  /** Whether the event's target is a text input, or inside Monaco. */
  inEditable: boolean;
}

const ACTIONS: Record<string, ReviewHunkAction> = {
  " ": "apply-hunk",
  a: "previous-hunk",
  d: "next-hunk",
  s: "next-file",
  w: "previous-file",
};

/** The review action `event` asks for, or null when it asks for none. */
export function reviewHunkAction(
  event: ReviewKeyEvent,
): ReviewHunkAction | null {
  if (event.inEditable) return null;
  if (event.altKey || event.ctrlKey || event.metaKey) return null;
  return ACTIONS[event.key.toLowerCase()] ?? null;
}

/**
 * Whether a keypress landed somewhere that owns its own keys.
 *
 * Exported for the listener, and separately from `reviewHunkAction`, because
 * this is the half that needs a real DOM node while the mapping above does
 * not.
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;

  const tag = target.tagName.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") return true;

  // Monaco: its focused element is a bare textarea in some versions and a
  // contenteditable div in others, so the editor container is the stable test.
  return target.closest(".monaco-editor") !== null;
}
