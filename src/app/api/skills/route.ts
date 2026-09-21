import { handleRouteError, requireUser } from "@/lib/api/api-helpers";
import { discoverSkills, labelSkillSource } from "@/lib/pi/skills/discover-skills";
import { resolveSessionCwd } from "@/lib/pi/session/session-cwd";
import { sessionProjects } from "@/lib/pi/session/session-project";
import { requireSessionOwner } from "@/lib/auth/session-auth";

export const runtime = "nodejs";

export interface PiSkillListing {
  name: string;
  description: string;
  source: string;
}

/**
 * The skills a session actually has available — mirrors `/api/tools`'s
 * session/no-session split. Without a `sessionId` (/sessions/new, or a
 * picker rendered before a session exists), skill discovery runs against the
 * workspace root, which `resolveSessionCwd` also falls back to for an
 * unanchored session; the answer is the same list either way, so there is no
 * separate branch for the missing-session case the way `/api/tools` has one.
 */
export async function GET(request: Request) {
  try {
    const sessionId = new URL(request.url).searchParams.get("sessionId");
    let cwd: string;

    if (sessionId) {
      await requireSessionOwner(sessionId, undefined, { allowMissing: true });
      const links = await sessionProjects(sessionId);
      cwd = resolveSessionCwd(links.map((link) => link.path));
    } else {
      await requireUser();
      cwd = resolveSessionCwd([]);
    }

    const { skills } = discoverSkills({ cwd });

    const listing: PiSkillListing[] = skills
      .map((skill) => ({
        description: skill.description,
        name: skill.name,
        source: labelSkillSource(skill.filePath, cwd),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return Response.json({ skills: listing });
  } catch (error) {
    return handleRouteError(error, "Unable to load skills.");
  }
}
