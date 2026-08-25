import { handleRouteError } from "@/lib/api-helpers";
import { requireSessionOwner } from "@/lib/session-auth";
import { deliverAnswer } from "@/lib/pi/ask-user-bridge";

export const runtime = "nodejs";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    await requireSessionOwner(id);
  } catch (error) {
    return handleRouteError(error, "Unable to authorize session.");
  }

  const body = (await request.json().catch(() => null)) as {
    answers?: Record<string, string>;
  } | null;

  if (!body?.answers || typeof body.answers !== "object") {
    return Response.json({ error: "answers object is required." }, { status: 400 });
  }

  const delivered = deliverAnswer(id, body.answers);

  if (!delivered) {
    return Response.json(
      { error: "No pending question for this session." },
      { status: 409 },
    );
  }

  return Response.json({ ok: true });
}
