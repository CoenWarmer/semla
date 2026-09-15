/**
 * Truncating a message list to the point a fork was made at.
 *
 * A fork does not create a branch — see docs/plans/branching-sessions.md §3.
 * It repositions where the *next* prompt will land, and the only visible
 * effect until that prompt is sent is that the conversation displays as if it
 * ended there: "you are forked here, nothing has diverged yet." Everything
 * after the forked message is not deleted — it is simply not shown, the same
 * way an edited message's abandoned reply is not deleted, only unreached.
 *
 * Shared between the render path (client-session-component.tsx, while a fork
 * is pending no prompt) and the optimistic-append path (use-prompt-mutation.ts,
 * the instant a prompt *is* sent from a fork) so the two agree on where "the
 * end of the visible conversation" is. Disagreeing would mean the optimistic
 * bubble appears after messages the fork was supposed to have cut off.
 */
export function truncateAtMessage<T extends { id: string }>(
  messages: readonly T[],
  forkedAt: string | null | undefined,
): T[] {
  if (!forkedAt) return [...messages];

  const index = messages.findIndex((message) => message.id === forkedAt);
  // Not found — the fork target scrolled out of what is loaded, or named
  // something stale. Showing everything is the same fallback the server
  // applies to an unresolvable leaf: the default conversation, not nothing.
  return index === -1 ? [...messages] : messages.slice(0, index + 1);
}
