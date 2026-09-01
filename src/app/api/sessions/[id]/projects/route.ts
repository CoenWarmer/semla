import { NextResponse } from "next/server";

import { requireSessionOwner } from "@/lib/session-auth";
import { handleRouteError } from "@/lib/api-helpers";
import { isWorkspaceProject } from "@/lib/pi/workspace-git";
import { PI_WORKSPACE_ROOT } from "@/lib/pi/runtime-config";
import { projectAbsolutePath, sessionProjects } from "@/lib/pi/session-project";
import {
  attachProject,
  detachProject,
  setPrimary,
} from "@/lib/pi/session-project-links";
import { updateSessionProjects } from "@/lib/pi/session-project-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The projects a session relates to, and the three things a user can do to
 * them: attach one, move the anchor, remove one.
 *
 * Every path here is workspace-relative, the identity the links are stored
 * under. It is checked against the workspace listing before anything is
 * written, so a session cannot come to name a directory the rest of the app
 * has no way to address.
 */

/** A workspace-relative path from the request, or null if it is not usable. */
const requestedPath = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;

/**
 * Whether `path` names a project this workspace actually has.
 *
 * `isWorkspaceProject` takes an absolute path, which is also what makes this
 * the containment check: a relative path that climbs out of the root resolves
 * to somewhere the listing does not contain, and is refused.
 */
const isAttachable = async (path: string): Promise<boolean> =>
  isWorkspaceProject(projectAbsolutePath({ path }, PI_WORKSPACE_ROOT));

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    await requireSessionOwner(id);
    return NextResponse.json({ projects: await sessionProjects(id) });
  } catch (error) {
    return handleRouteError(error, "Unable to load the session's projects.");
  }
}

/** Attach a project the user chose. Already-linked is success, not an error. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    await requireSessionOwner(id);

    const body = await request.json().catch(() => null);
    const path = requestedPath(body?.path);
    if (!path || !(await isAttachable(path))) {
      return NextResponse.json(
        { message: "Not a project in this workspace." },
        { status: 400 },
      );
    }

    const result = await updateSessionProjects(id, (links) =>
      attachProject(links, {
        at: new Date().toISOString(),
        origin: "explicit",
        path,
        primary: body?.primary === true,
      }),
    );

    return respond(result);
  } catch (error) {
    return handleRouteError(error, "Unable to attach the project.");
  }
}

/**
 * Move the anchor to a project the session already relates to.
 *
 * Deliberately works on observed links too: a session that discovered its real
 * subject by writing to a repo should be able to adopt it, which is the whole
 * reason the anchor is a separate flag from how the link came to exist.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    await requireSessionOwner(id);

    const body = await request.json().catch(() => null);
    const path = requestedPath(body?.path);
    if (!path) {
      return NextResponse.json({ message: "No project given." }, { status: 400 });
    }

    const result = await updateSessionProjects(id, (links) =>
      links.some((link) => link.path === path) ? setPrimary(links, path) : null,
    );

    if (result.status === "refused") {
      return NextResponse.json(
        { message: "This session does not relate to that project." },
        { status: 404 },
      );
    }

    return respond(result);
  } catch (error) {
    return handleRouteError(error, "Unable to change the anchor.");
  }
}

/**
 * Detach a project the user attached.
 *
 * Refused with 409 for a link the agent earned by writing there. That is not a
 * permissions quirk: the observed set is a record of what the session did, and
 * a log you can edit is not a log.
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    await requireSessionOwner(id);

    const path = requestedPath(new URL(request.url).searchParams.get("path"));
    if (!path) {
      return NextResponse.json({ message: "No project given." }, { status: 400 });
    }

    const result = await updateSessionProjects(id, (links) =>
      detachProject(links, path),
    );

    if (result.status === "refused") {
      return NextResponse.json(
        {
          message:
            "This project was attached because the agent wrote to it, and is part of the session's record.",
        },
        { status: 409 },
      );
    }

    return respond(result);
  } catch (error) {
    return handleRouteError(error, "Unable to detach the project.");
  }
}

const respond = (
  result: Awaited<ReturnType<typeof updateSessionProjects>>,
): NextResponse =>
  result.status === "ok"
    ? NextResponse.json({ projects: result.links })
    : NextResponse.json({ message: "Session not found." }, { status: 404 });
