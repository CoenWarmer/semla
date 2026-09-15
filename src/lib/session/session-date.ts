/**
 * How a session's timestamp is written in the sidebar.
 *
 * Shared because rows now come from two places: rendered on the server from the
 * session list, and added on the client from the status poll when a session
 * appears mid-navigation. Two copies of the format would drift, and the
 * difference would show as one row in the list looking unlike its neighbours.
 */
export const formatSessionDate = (value: string): string =>
  new Date(value).toLocaleDateString("nl-NL", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
