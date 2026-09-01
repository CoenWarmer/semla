/**
 * What a browser may ask a terminal to do.
 *
 * Everything here crosses from a request body into `pty.write` and
 * `pty.resize`, so it is parsed rather than trusted. The shapes are tiny; the
 * point is that there is exactly one place that decides what a control message
 * is, and it is a pure function a test can hold to account.
 *
 * Client-safe on purpose — the component that sends these builds them from the
 * same types the route validates.
 */

export type TerminalControl =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "kill" };

/**
 * A terminal's dimensions.
 *
 * Bounded rather than merely positive: `pty.resize` takes these straight to an
 * ioctl, and a zero, a fraction or an implausible number is a bad request
 * rather than something to pass along and find out about.
 */
export const MIN_COLS = 1;
export const MAX_COLS = 1000;
export const MIN_ROWS = 1;
export const MAX_ROWS = 500;

const isSize = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= min &&
  value <= max;

export const isValidCols = (value: unknown): value is number =>
  isSize(value, MIN_COLS, MAX_COLS);

export const isValidRows = (value: unknown): value is number =>
  isSize(value, MIN_ROWS, MAX_ROWS);

/**
 * Read a control message, or null if the body is not one.
 *
 * Null rather than a thrown error: the caller answers 400, and there is nothing
 * useful to say about a body that did not parse beyond that it did not.
 */
export function parseTerminalControl(body: unknown): TerminalControl | null {
  if (typeof body !== "object" || body === null) return null;
  const message = body as Record<string, unknown>;

  switch (message.type) {
    case "input":
      // An empty string is allowed: it writes nothing, which is harmless, and
      // rejecting it would be a rule the client has to know about for no gain.
      return typeof message.data === "string"
        ? { data: message.data, type: "input" }
        : null;

    case "resize":
      return isValidCols(message.cols) && isValidRows(message.rows)
        ? { cols: message.cols, rows: message.rows, type: "resize" }
        : null;

    case "kill":
      return { type: "kill" };

    default:
      return null;
  }
}
