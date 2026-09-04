import { isAbsolute, join, relative } from "node:path";

import { NextResponse } from "next/server";

import { handleRouteError } from "@/lib/api-helpers";
import { requireSessionOwner } from "@/lib/session-auth";
import { resolveInsideRoot, toRelativePath } from "@/lib/pi/file-browser";
import { SEMLA_PROJECT_PATH } from "@/lib/pi/runtime-config";
import { attachProject } from "@/lib/pi/session-project-links";
import { updateSessionProjects } from "@/lib/pi/session-project-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Turn a source location the element picker found into a Review panel
 * selection: Semla's own repository, attached to this session if it is not
 * already, and the file's path within it.
 *
 * Development only. `element-locator.ts` on the client resolves the fiber's
 * debug stack to a source file via Next's own devtools endpoint, but what
 * that endpoint returns is absolute under Turbopack and already relative
 * under webpack (see the normalization below) — either way, this route
 * refuses anything that resolves outside Semla's own checkout rather than
 * trusting the client's shape, which is what makes attaching a project from
 * it safe.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (process.env.NODE_ENV !== "development") {
    return NextResponse.json({ error: "Development only." }, { status: 403 });
  }

  // Narrowed to a local: captured inside the closure below, TypeScript
  // cannot see that the guard above already ruled out null.
  const projectPath = SEMLA_PROJECT_PATH;
  if (!projectPath) {
    return NextResponse.json(
      {
        error:
          "Semla's own checkout is not inside PI_WORKSPACE_ROOT, so it cannot be opened as a project.",
      },
      { status: 400 },
    );
  }

  try {
    const { id } = await params;
    await requireSessionOwner(id);

    const body = await request.json().catch(() => null);
    const rawPath = typeof body?.path === "string" ? body.path : null;
    if (!rawPath) {
      return NextResponse.json({ error: "path required" }, { status: 400 });
    }

    /**
     * The path the client sends is whatever Next's own devtools endpoint
     * resolved a stack frame to — Turbopack returns that absolute (Node's
     * `findSourceMap`/source-map `source` field), while webpack's equivalent
     * middleware already relativizes it. Either shape is resolved against
     * Semla's own checkout — `process.cwd()`, the same root the Next dev
     * server itself resolves stack frames against — and re-derived with
     * `resolveInsideRoot`/`toRelativePath`, the same containment check every
     * other file route in this repository uses (`relative` rather than a
     * string prefix, so `src/../../outside` cannot slip past the way a bare
     * `startsWith("..")` check on the raw string would).
     */
    const absolute = isAbsolute(rawPath) ? rawPath : join(process.cwd(), rawPath);
    const contained = resolveInsideRoot(process.cwd(), relative(process.cwd(), absolute));

    if (!contained) {
      return NextResponse.json(
        { error: "That file is outside Semla's own checkout." },
        { status: 400 },
      );
    }

    const path = toRelativePath(process.cwd(), contained);

    const result = await updateSessionProjects(id, (links) =>
      attachProject(links, {
        at: new Date().toISOString(),
        origin: "explicit",
        path: projectPath,
      }),
    );

    if (result.status !== "ok") {
      return NextResponse.json({ error: "Session not found." }, { status: 404 });
    }

    return NextResponse.json({ path, project: projectPath });
  } catch (error) {
    return handleRouteError(error, "Unable to open that element's source.");
  }
}
