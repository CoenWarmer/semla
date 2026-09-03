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

/** Where the slot is mirrored so a reload does not lose it. */
const KEY = "semla.pending-prompt";

type Slot = { prompt: PendingPrompt; sessionId: string };

/**
 * sessionStorage, when there is one.
 *
 * Absent during server rendering, and it throws rather than returning null in
 * a browser with storage disabled — so every access is guarded and a failure
 * degrades to the in-memory slot rather than breaking the handoff.
 */
const storage = (): Storage | null => {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
};

const read = (): Slot | null => {
  const raw = storage()?.getItem(KEY);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as Slot;
    // These come back from storage, where anything could have written them.
    return typeof parsed?.sessionId === "string" &&
      typeof parsed.prompt?.text === "string"
      ? parsed
      : null;
  } catch {
    return null;
  }
};

const write = (slot: Slot | null): void => {
  const store = storage();
  if (!store) return;

  try {
    if (slot) store.setItem(KEY, JSON.stringify(slot));
    else store.removeItem(KEY);
  } catch {
    // Private mode, or a full quota. The in-memory slot still works for the
    // soft navigation this is mainly for.
  }
};

/**
 * Single-slot, session-keyed handoff for a session's first prompt.
 *
 * Only one prompt is ever in flight here — it is written immediately before a
 * navigation and read immediately after — so a single slot is enough, and
 * keying it by session means a prompt can never be replayed into a session it
 * was not meant for. Reads clear the slot so the prompt is submitted once.
 *
 * **Mirrored into sessionStorage**, which is not belt-and-braces. The slot
 * used to live only in React state above both routes, and the prompt it holds
 * is the only submit that carries the `create` payload the prompt route needs
 * — the prompt bar's own submits do not. So a hard load between minting the id
 * and submitting left a session that was never created and could not be, and
 * every prompt typed into it answered 404 forever. That page now says so, and
 * with this it mostly does not happen.
 *
 * sessionStorage rather than localStorage: the handoff is meaningful for one
 * tab and one navigation, and a stale prompt replaying into a new tab days
 * later is the failure this is supposed to prevent, not one to introduce.
 *
 * Kept free of React so the semantics can be tested directly.
 */
export function createPendingPromptStore(): PendingPromptStore {
  let pending: Slot | null = null;

  return {
    set(sessionId, prompt) {
      pending = { prompt, sessionId };
      write(pending);
    },

    consume(sessionId) {
      // Memory first: it is the same object that was set, and storage is only
      // consulted when this store is a fresh one after a reload.
      const slot = pending ?? read();
      if (!slot || slot.sessionId !== sessionId) return null;

      pending = null;
      write(null);
      return slot.prompt;
    },
  };
}
