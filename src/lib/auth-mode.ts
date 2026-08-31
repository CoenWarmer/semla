/**
 * Whether this Semla needs to authenticate anyone.
 *
 * Semla is a single-user tool. On a laptop, bound to loopback, an auth round
 * trip buys nothing and costs everything when Supabase is unreachable — which
 * is how a database outage took the whole UI down, including pages backed only
 * by the filesystem.
 *
 * The decision is made from the address the server is bound to, not from the
 * request. A per-request "is this localhost?" test could only read the Host
 * header, which the client sets — so anyone on the network could ask for
 * localhost and be believed. NextRequest exposes no peer address to check it
 * against. Binding is not spoofable: on loopback nothing off-machine can
 * connect at all, so "local" is enforced by the socket rather than trusted from
 * a header.
 *
 * SEMLA_BIND_HOST drives both the bind (see the dev script) and this policy, so
 * the two cannot disagree. Exposing Semla means changing it, which turns
 * authentication on in the same move.
 */

import { listSessionMeta } from "@/lib/pi/session-meta";

// Blank counts as unset: `SEMLA_BIND_HOST=` in an env file would otherwise
// leave an empty host, which is not loopback and would demand a sign-in nobody
// asked for.
export const BIND_HOST = process.env.SEMLA_BIND_HOST?.trim() || "127.0.0.1";

/** Addresses that only accept connections from this machine. */
export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "0:0:0:0:0:0:0:1" ||
    /^127\./.test(normalized)
  );
}

/** False only while the server is reachable from this machine alone. */
export const AUTH_REQUIRED = !isLoopbackHost(BIND_HOST);

/**
 * A stable id standing in for the signed-in user when nobody signs in.
 *
 * Sessions are owned by a user id, and existing ones already carry the id from
 * Supabase Auth. Inferring it from the records on disk keeps that history
 * visible instead of stranding it behind an identity that owns nothing. Only
 * when the records agree — more than one owner is a question this cannot
 * answer, and SEMLA_LOCAL_USER_ID settles it.
 */
const FALLBACK_LOCAL_USER_ID = "00000000-0000-4000-8000-000000000001";

let cachedLocalUserId: string | undefined;

export function localUserId(): string {
  if (cachedLocalUserId) return cachedLocalUserId;

  const configured = process.env.SEMLA_LOCAL_USER_ID?.trim();
  if (configured) {
    cachedLocalUserId = configured;
    return cachedLocalUserId;
  }

  const owners = new Set(
    listSessionMeta()
      .map((meta) => meta.userId)
      .filter((id): id is string => Boolean(id)),
  );

  cachedLocalUserId = owners.size === 1 ? [...owners][0]! : FALLBACK_LOCAL_USER_ID;
  return cachedLocalUserId;
}

/** The shape route handlers use from a Supabase user. */
export const localUser = (): { id: string } => ({ id: localUserId() });
