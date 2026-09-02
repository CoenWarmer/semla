/**
 * The order in which a streamed answer becomes a stored one.
 *
 * The streamed bubble and the persisted assistant message are two renderings
 * of the same text. The turn used to clear the stream and *then* refetch the
 * transcript, which left a gap the length of that request — 185ms to 316ms
 * across the turns of a captured session — in which the answer that had just
 * finished streaming was on screen in neither form, and the conversation
 * flashed.
 *
 * Exported and taken apart like this so the ordering is pinned by a test,
 * rather than living as two adjacent statements in a hook whose order looks
 * arbitrary.
 */

export const handOffStreamedAnswer = async ({
  clearStreamed,
  loadTranscript,
}: {
  /** Drop the streamed copy. Runs only once the stored one can be rendered. */
  clearStreamed: () => void;
  /** Refetch the transcript, resolving when the new data is readable. */
  loadTranscript: () => Promise<unknown>;
}): Promise<void> => {
  try {
    await loadTranscript();
  } finally {
    // In a `finally`: a refetch that fails must not strand the bubble against
    // a transcript that will never come, leaving the answer on screen twice
    // the next time anything does load.
    clearStreamed();
  }
};
