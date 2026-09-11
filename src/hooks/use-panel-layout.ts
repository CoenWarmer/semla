"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef } from "react";

import type { PanelLayoutValue, PanelLayouts } from "@/lib/panel-layout-store";

export const panelLayoutQueryKey = ["panel-layout"] as const;

const fetchPanelLayouts = async (): Promise<PanelLayouts> => {
  const response = await fetch("/api/panel-layout");
  if (!response.ok) throw new Error("Unable to load panel layouts.");
  const { layouts } = (await response.json()) as { layouts: PanelLayouts };
  return layouts;
};

const savePanelLayout = async (
  patch: Record<string, PanelLayoutValue>,
): Promise<PanelLayouts> => {
  const response = await fetch("/api/panel-layout", {
    body: JSON.stringify(patch),
    headers: { "Content-Type": "application/json" },
    method: "PUT",
  });
  if (!response.ok) throw new Error("Unable to save panel layout.");
  const { layouts } = (await response.json()) as { layouts: PanelLayouts };
  return layouts;
};

/**
 * All saved panel layouts, fetched once per session and cached.
 *
 * Every resizable panel in the app reads from this one query rather than
 * fetching its own key, so opening a session with five resizable groups
 * costs one request, not five.
 */
export const usePanelLayouts = () =>
  useQuery({
    queryFn: fetchPanelLayouts,
    queryKey: panelLayoutQueryKey,
    // Session-lifetime data: nothing else writes this file, and this hook's
    // own save already updates the cache directly on success.
    staleTime: Infinity,
  });

/**
 * One saved layout's value, with a saver debounced against the drag that
 * produced it.
 *
 * Debounced client-side rather than relying on the library's own
 * `onLayoutChange` (fired on every pointer move): a drag is dozens of percent
 * updates a second, and writing each one to disk would turn a resize into a
 * filesystem hazard. `onLayoutChanged` (the library's post-drag callback)
 * already coalesces pointer-driven changes, but the bottom bar and the
 * transcript drawer resize with their own pointer handlers, not this
 * library, and need the same debounce to avoid the same hazard.
 */
export function usePanelLayoutSaver(
  key: string,
  delayMs = 400,
): (value: PanelLayoutValue) => void {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: savePanelLayout,
    onSuccess: (layouts) => {
      queryClient.setQueryData(panelLayoutQueryKey, layouts);
    },
  });

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mutateRef = useRef(mutation.mutate);

  useEffect(() => {
    mutateRef.current = mutation.mutate;
  }, [mutation.mutate]);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  return useCallback(
    (value: PanelLayoutValue) => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        mutateRef.current({ [key]: value });
      }, delayMs);
    },
    [key, delayMs],
  );
}
