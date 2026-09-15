import { handleRouteError } from "@/lib/api-helpers";
import { requireSessionOwner } from "@/lib/session-auth";
import { deliverFeatureSpec } from "@/lib/pi/bridge/feature-spec-bridge";

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
    goal?: string;
    functionalRequirements?: string;
    nonFunctionalRequirements?: string;
  } | null;

  if (
    !body ||
    typeof body.goal !== "string" ||
    typeof body.functionalRequirements !== "string" ||
    typeof body.nonFunctionalRequirements !== "string"
  ) {
    return Response.json(
      { error: "goal, functionalRequirements and nonFunctionalRequirements are required." },
      { status: 400 },
    );
  }

  const delivered = deliverFeatureSpec(id, {
    functionalRequirements: body.functionalRequirements,
    goal: body.goal,
    nonFunctionalRequirements: body.nonFunctionalRequirements,
  });

  if (!delivered) {
    return Response.json(
      { error: "No pending feature spec request for this session." },
      { status: 409 },
    );
  }

  return Response.json({ ok: true });
}
