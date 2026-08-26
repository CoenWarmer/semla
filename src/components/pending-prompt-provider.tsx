"use client";

import { createContext, useContext, useState, type ReactNode } from "react";

import {
  createPendingPromptStore,
  type PendingPromptStore,
} from "@/lib/pending-prompt-store";

export type { PendingPrompt, PendingPromptStore } from "@/lib/pending-prompt-store";

const PendingPromptContext = createContext<PendingPromptStore | null>(null);

/**
 * Carries the first prompt of a new session across the client-side navigation
 * that follows creating it.
 *
 * A session cannot be prompted before its row exists, and the first turn's
 * assistant deltas only stream to the request that started it — so the session
 * page has to be the one to submit, after navigation. This provider is the
 * handoff. It lives above both routes in the root layout, so it survives the
 * soft navigation between them.
 *
 * The store is held in state rather than as rendered value: nothing renders
 * from it, so stashing a prompt must not re-render every route beneath the
 * layout.
 */
export function PendingPromptProvider({ children }: { children: ReactNode }) {
  const [store] = useState(createPendingPromptStore);

  return (
    <PendingPromptContext.Provider value={store}>
      {children}
    </PendingPromptContext.Provider>
  );
}

export function usePendingPrompt(): PendingPromptStore {
  const store = useContext(PendingPromptContext);

  if (!store) {
    throw new Error(
      "usePendingPrompt must be used inside a PendingPromptProvider.",
    );
  }

  return store;
}
