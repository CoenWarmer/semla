import { NextResponse } from "next/server";

import { handleRouteError } from "@/lib/api/api-helpers";
import { requireSessionOwner } from "@/lib/auth/session-auth";
import { splitWorkspacePath } from "@/lib/paths/workspace-path";
import { sessionProjects } from "@/lib/pi/session/session-project";
import { wikiPageWorkspacePath } from "@/lib/wiki/wiki-page-location";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Where a wiki page opens in the Review panel: which of this session's
 * attached projects its `.md` file falls under, and its path within it.
 *
 * A wiki page's identity (`folder/slug`) is not a workspace path — see
 * wiki-page-location.ts for the coordinate systems being reconciled here.
 * This is the same shape of answer `openWorkspacePath` computes for Go to
 * Definition, and the same reason it can come up empty: the file API only
 * resolves paths inside a session's own projects, so a vault outside every
 * attached one has nowhere for this to open it.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    await requireSessionOwner(id);

    const pageId = new URL(request.url).searchParams.get("id");
    if (!pageId) {
      return NextResponse.json({ error: "id required" }, { status: 400 });
    }

    const workspacePath = wikiPageWorkspacePath(pageId);
    if (!workspacePath) {
      return NextResponse.json(
        { error: "This page's file could not be found in the workspace." },
        { status: 404 },
      );
    }

    const projects = await sessionProjects(id);
    const selection = splitWorkspacePath(
      projects.map((project) => project.path),
      workspacePath,
    );

    if (!selection) {
      return NextResponse.json(
        {
          error:
            "This page is not inside a project this session is linked to, so it cannot be opened here.",
        },
        { status: 404 },
      );
    }

    return NextResponse.json(selection);
  } catch (error) {
    return handleRouteError(error, "Unable to resolve that wiki page.");
  }
}
