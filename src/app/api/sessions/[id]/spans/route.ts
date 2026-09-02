import { handleRouteError } from "@/lib/api-helpers";
import { readSpans } from "@/lib/pi/telemetry/span-store";
import { requireSessionOwner } from "@/lib/session-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The spans recorded for this session, so a reload draws the real trace.
 *
 * Without this the timeline falls back to the derived one the moment the page
 * is refreshed, because live spans only ever existed in the turn's stream.
 *
 * `allowMissing` for the same reason every other read on this route tree has
 * it: a session created by its own first prompt is polled before it exists,
 * and an empty answer is the right one. This only reads.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    await requireSessionOwner(id, undefined, { allowMissing: true });

    return Response.json({ spans: await readSpans(id) });
  } catch (error) {
    return handleRouteError(error, `[sessions/${id}/spans]`);
  }
}
