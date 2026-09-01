"use client";

import { useEffect, useState } from "react";

/**
 * `value`, held back until it has stopped changing for `delayMs`.
 *
 * The file search walks the workspace on the server, so issuing one per
 * keystroke would spend a filesystem sweep on every prefix of the word being
 * typed. Debouncing the query — rather than the request — keeps the input
 * itself responsive.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}
