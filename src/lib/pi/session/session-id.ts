/**
 * The id a client asked a session to be created with.
 *
 * /sessions/new mints the id itself so it can navigate to the session — and
 * prefetch it — before the creating request is even sent. That makes the id
 * untrusted input which becomes a primary key, appears in every filesystem
 * path derived from the session, and is interpolated into URLs, so it is
 * validated to the one shape it may have rather than passed through.
 *
 * Null means "no usable id was supplied", which the route treats as a request
 * for Postgres to name the session itself, exactly as before.
 */

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const parseRequestedSessionId = (value: unknown): string | null => {
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  return UUID.test(trimmed) ? trimmed.toLowerCase() : null;
};
