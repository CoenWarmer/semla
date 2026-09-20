"use client";

import { useEffect, useRef, useState, type RefObject } from "react";

/**
 * Tracks an element's border-box width via `ResizeObserver`, for layout
 * decisions that need to react to the element's own size rather than the
 * viewport's — e.g. a toolbar that hides its labels once its container (not
 * the window) gets too narrow, such as when a side panel splits the column
 * it sits in.
 *
 * `null` until the element has mounted and reported a first size, so
 * callers can treat "not yet measured" differently from "measured as zero".
 */
export function useElementWidth<
  T extends HTMLElement,
>(): [RefObject<T | null>, number | null] {
  const ref = useRef<T | null>(null);
  const [width, setWidth] = useState<number | null>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(node);

    return () => observer.disconnect();
  }, []);

  return [ref, width];
}
