import { handleRouteError, requireUser } from "@/lib/api/api-helpers";
import {
  readPanelLayouts,
  writePanelLayouts,
  type PanelLayoutValue,
} from "@/lib/stores/panel-layout-store";

export const runtime = "nodejs";

export async function GET() {
  try {
    const { user } = await requireUser();
    return Response.json({ layouts: readPanelLayouts(user.id) ?? {} });
  } catch (error) {
    return handleRouteError(error, "Unable to load panel layouts.");
  }
}

const isValidValue = (value: unknown): value is PanelLayoutValue => {
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "boolean") return true;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every(
    (v) => typeof v === "number" && Number.isFinite(v),
  );
};

export async function PUT(request: Request) {
  const body = (await request.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;

  if (!body || typeof body !== "object") {
    return Response.json({ error: "Nothing to update." }, { status: 400 });
  }

  const patch: Record<string, PanelLayoutValue> = {};
  for (const [key, value] of Object.entries(body)) {
    if (!isValidValue(value)) {
      return Response.json(
        { error: `Invalid layout value for "${key}".` },
        { status: 400 },
      );
    }
    patch[key] = value;
  }

  if (Object.keys(patch).length === 0) {
    return Response.json({ error: "Nothing to update." }, { status: 400 });
  }

  try {
    const { user } = await requireUser();
    const layouts = writePanelLayouts(user.id, patch);
    return Response.json({ layouts });
  } catch (error) {
    return handleRouteError(error, "Unable to save panel layouts.");
  }
}
