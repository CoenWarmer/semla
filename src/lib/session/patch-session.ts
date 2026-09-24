/**
 * Update a session's own record: its title, goal, or whether review was open.
 *
 * Throws on a non-2xx answer. `fetch` only rejects when the request never
 * reached the server, so without the status check a refused or failed PATCH
 * looked exactly like a saved one, and the optimistic value stayed on screen
 * until the next reload quietly put the old one back.
 */
export async function patchSession(
  sessionId: string,
  body: { goal?: string; reviewManuallyOpened?: boolean; title?: string },
): Promise<void> {
  const response = await fetch(`/api/sessions/${sessionId}`, {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    method: "PATCH",
  });
  if (!response.ok) {
    throw new Error(`Session update failed with ${response.status}.`);
  }
}
