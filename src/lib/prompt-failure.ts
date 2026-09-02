/**
 * Why a prompt could not start, said usefully.
 *
 * A session is created by its own first prompt: /sessions/new mints the id,
 * navigates, and hands the prompt over in memory for the session page to
 * submit. That handoff is the only submit carrying the `create` payload the
 * prompt route needs — the prompt bar's own submits do not — and it lives in
 * React state, so a hard load drops it.
 *
 * What that left behind was a page that looks entirely normal and answers 404
 * to every prompt typed into it, forever, under the message "Pi could not
 * start this prompt." Both halves of that are fixed here: the route's own
 * message is surfaced, and the dead end is named before anyone retypes into
 * it.
 */

/** What the prompt route returns when it refuses. */
type ErrorBody = { error?: unknown };

/**
 * The message to raise for a failed prompt request.
 *
 * Reads the body only on failure. A successful response body is the event
 * stream, and consuming it would end the turn it was about to carry.
 */
export const promptFailureMessage = async (
  response: Pick<Response, "json" | "ok">,
): Promise<string> => {
  const fallback = "Pi could not start this prompt.";
  if (response.ok) return fallback;

  const detail = await response
    .json()
    .then((body: unknown) => {
      const error = (body as ErrorBody | null)?.error;
      return typeof error === "string" && error.trim() ? error : null;
    })
    // A non-JSON body is a proxy or a crash page, not something to show.
    .catch(() => null);

  return detail ?? fallback;
};

/**
 * Whether this page is a session that was never created and cannot be.
 *
 * `exists` is undefined until the first status poll answers, and undefined is
 * not a claim — a `?new=1` page is legitimately promptable before its session
 * exists, which is the whole point of creating on first prompt.
 *
 * `promptIdle` is what makes this flash-free. A page that *does* have a
 * handoff calls the mutation within a tick of mounting, far sooner than a
 * status poll can answer, so a mutation still idle when the answer arrives
 * means no handoff ever came. `promptErrored` keeps the notice up after
 * someone has typed and been refused.
 */
export const isSessionMissing = (state: {
  exists: boolean | undefined;
  promptErrored: boolean;
  promptIdle: boolean;
}): boolean =>
  state.exists === false && (state.promptIdle || state.promptErrored);
