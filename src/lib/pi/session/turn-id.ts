/**
 * The durable identity of one prompt turn.
 *
 * This is the join the rest of this work item exists for: SPEC.md keys a
 * turn by a durable ordinal, and session artifacts key a round by
 * `roundId` — which its own docblock (artifact-types.ts) says is client-local,
 * regenerated per process, and that nothing may key on. Neither survives a
 * reload or names the same thing the other does. `turnId` is minted once, in
 * `src/app/api/sessions/[id]/prompt/route.ts`, immediately before the turn's
 * first git read (`recordTurnStart`), and threaded through three durable
 * channels — the review turn mark, the artifact capture pipeline, and the
 * `CURRENT_TURN` contract slot the spec extensions read.
 *
 * Not a bare `Date.now()`/ISO reading: two systems already mint "now"
 * independently for one turn (`session-service.ts`'s `turnStartedAt` and
 * `recordTurnStart`'s own timestamp), and that drift is exactly the defect a
 * shared identity is supposed to remove. Not a counter either — pi's own
 * `TurnStartEvent.turnIndex` is in-memory, reset per `agent_start`, and
 * unusable for the same reason `roundSeq` is: process state, not disk state.
 *
 * The format is deliberately readable, not opaque: `<compact ISO>-<8 hex>` —
 * e.g. `20260910T121212345Z-a1b2c3d4` — so a `turnId` dropped into a JSONL
 * line or a SPEC.md line is greppable and roughly sortable by eye, and the
 * random suffix means two turns minted in the same millisecond (impossible
 * today, since minting happens at most once per HTTP request, but cheap to
 * make safe) still differ.
 */

import { randomBytes } from "node:crypto";

const TURN_ID_RE = /^\d{8}T\d{9}Z-[0-9a-f]{8}$/;

/** `YYYYMMDDTHHMMSSmmmZ` — sortable, and distinguishable from an ISO string
 * (no colons, no dashes inside the date/time part) so a reader can tell a
 * `turnId` apart from a plain timestamp at a glance. */
function compactIso(now: Date): string {
  const iso = now.toISOString(); // 2026-09-10T12:12:12.345Z
  return iso.replace(/[-:]/g, "").replace(".", "");
}

/**
 * Mint a new turn id. Called exactly once per prompt turn — see this
 * module's docblock for why that one call site is load-bearing.
 */
export function mintTurnId(now: Date = new Date()): string {
  const suffix = randomBytes(4).toString("hex");
  return `${compactIso(now)}-${suffix}`;
}

/** Shape guard, for tests and for defensively rejecting a malformed value
 * read back off disk (an old-format line, a hand-edited file). */
export function isTurnId(value: string): boolean {
  return TURN_ID_RE.test(value);
}
