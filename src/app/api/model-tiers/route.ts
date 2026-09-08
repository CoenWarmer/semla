import { handleRouteError, requireUser } from "@/lib/api-helpers";
import {
  getProjectModelTierConfigPath,
  loadModelTierConfig,
  saveModelTierConfig,
  type ModelTierConfig,
} from "@/lib/pi/extensions/dynamic-workflows/src/model-tier-config.ts";

export const runtime = "nodejs";

const ALLOWED_TIER_NAMES = ["small", "medium", "big"] as const;
type AllowedTier = (typeof ALLOWED_TIER_NAMES)[number];

function isAllowedTier(name: string): name is AllowedTier {
  return (ALLOWED_TIER_NAMES as readonly string[]).includes(name);
}

export async function GET() {
  try {
    await requireUser();
    // Read the repository file by its exact path rather than through
    // loadModelTierConfig({ cwd }), which falls back to ~/.pi/workflows when
    // the project has no file. That fallback is right for *resolving* a
    // subagent's model — it is what a WorkflowAgent does — but wrong here:
    // this endpoint backs an editor labelled as the committed repo config, so
    // a fallback would display another project's tiers as though they were
    // this repository's, and the next save would copy them in.
    const config = loadModelTierConfig(
      getProjectModelTierConfigPath(process.cwd()),
    );

    // Return an explicit "absent" shape when no config exists, so the caller
    // can distinguish "unset" (tiers fall back to the session model) from
    // "configured". Sending { tiers: {} } would be misleading: an empty map is
    // degenerate and loadModelTierConfig rejects it as null.
    if (!config) {
      return Response.json({ exists: false, tiers: null });
    }

    return Response.json({ exists: true, tiers: config.tiers });
  } catch (error) {
    return handleRouteError(error, "Unable to load model tier configuration.");
  }
}

export async function PUT(request: Request) {
  const body = (await request.json().catch(() => null)) as { tiers?: unknown } | null;

  if (!body || typeof body.tiers !== "object" || body.tiers === null || Array.isArray(body.tiers)) {
    return Response.json({ error: "Request body must contain a tiers object." }, { status: 400 });
  }

  const rawTiers = body.tiers as Record<string, unknown>;

  // Reject unknown tier names: only small/medium/big are meaningful, because
  // resolveTierModel is an exact-key lookup and anything else silently falls
  // back to the session model — the user would *think* they configured
  // routing, but unrecognized names do nothing.
  const unknownTiers = Object.keys(rawTiers).filter((name) => !isAllowedTier(name));
  if (unknownTiers.length > 0) {
    return Response.json(
      {
        error: `Unknown tier names: ${unknownTiers.join(", ")}. Only "small", "medium", and "big" are allowed.`,
      },
      { status: 400 },
    );
  }

  // Cleared tier decision: A tier mapped to an empty string or absent from the
  // map both resolve to undefined in resolveTierModel. To keep the config
  // meaningful and avoid the degenerate-map rejection saveModelTierConfig
  // enforces, remove cleared tiers from the map rather than storing them as "".
  // If the user clears all three, the resulting empty map is rejected here
  // with an explicit message rather than passed to saveModelTierConfig, which
  // would throw.
  const validTiers: Record<string, string> = {};
  for (const [tier, value] of Object.entries(rawTiers)) {
    if (typeof value === "string" && value.trim().length > 0) {
      validTiers[tier] = value;
    }
  }

  if (Object.keys(validTiers).length === 0) {
    return Response.json(
      {
        error:
          "All tiers are cleared. To disable tier routing, delete the configuration file. An empty tier map is not a valid config.",
      },
      { status: 400 },
    );
  }

  try {
    await requireUser();
    const configPath = getProjectModelTierConfigPath(process.cwd());
    const config: ModelTierConfig = { tiers: validTiers };

    // saveModelTierConfig throws on a degenerate map (covered above), so this
    // only fails on actual write errors.
    saveModelTierConfig(config, configPath);

    return Response.json({ exists: true, tiers: config.tiers });
  } catch (error) {
    return handleRouteError(error, "Unable to save model tier configuration.");
  }
}
