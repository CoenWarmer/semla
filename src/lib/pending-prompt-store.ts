import type { PromptEditorModel } from "@/components/prompt-editor";

/** The first prompt of a session, handed from /sessions/new to /sessions/[id]. */
export type PendingPrompt = {
  /**
   * Present when the session does not exist yet, and carries what creating it
   * needs.
   *
   * /sessions/new used to POST the session and wait for its id before it could
   * navigate anywhere — two round trips of nothing happening after a click. It
   * now mints the id itself and navigates immediately, which leaves creation to
   * the page that arrives. Absent for a session that already exists.
   */
  create?: { project: string | null; title: string };
  goal?: string | null;
  model: PromptEditorModel;
  text: string;
  tools: string[];
};

export type PendingPromptStore = {
  /** Stash the first prompt for a session that is about to be navigated to. */
  set: (sessionId: string, prompt: PendingPrompt) => void;
  /**
   * Read and clear the prompt stashed for this session. Returns null when
   * nothing was stashed, or when the stashed prompt belongs to another session.
   */
  consume: (sessionId: string) => PendingPrompt | null;
};

/**
 * Single-slot, session-keyed handoff for a session's first prompt.
 *
 * Only one prompt is ever in flight here — it is written immediately before a
 * navigation and read immediately after — so a single slot is enough, and
 * keying it by session means a prompt can never be replayed into a session it
 * was not meant for. Reads clear the slot so the prompt is submitted once.
 *
 * Kept free of React so the semantics can be tested directly.
 */
export function createPendingPromptStore(): PendingPromptStore {
  let pending: { prompt: PendingPrompt; sessionId: string } | null = null;

  return {
    set(sessionId, prompt) {
      pending = { prompt, sessionId };
    },

    consume(sessionId) {
      if (!pending || pending.sessionId !== sessionId) return null;

      const { prompt } = pending;
      pending = null;
      return prompt;
    },
  };
}
