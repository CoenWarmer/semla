import { NextResponse } from "next/server";

import { definitionAt } from "@/lib/code-map/definition";
import { resolveFileRoot, toRelativePath } from "@/lib/pi/file-browser";
import { resolveReviewFile, resolveReviewTarget } from "@/lib/pi/review-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Where the symbol under a cursor is declared.
 *
 * The review editor runs Monaco without a language service (see
 * monaco-setup.ts), so cmd+click cannot be answered in the browser. This is
 * the same shape as the sibling `symbol` route — a position in a reviewed
 * file, resolved by the TypeScript checker on the server — with a column
 * added, because a definition is about a token rather than a line.
 *
 * **The answer is a workspace-relative path, not a project-relative one.**
 * The request is project-relative, because that is how the panel addresses the
 * file it has open; but a definition can legitimately land in a *different*
 * repository of the same session, or in `node_modules` of the one asked about,
 * and neither is expressible relative to the project. `definitionAt` reports
 * relative to the project root, so the two are composed back into a workspace
 * path here — the one address every consumer of this answer already speaks.
 *
 * A null definition is a successful answer. Clicking punctuation, a keyword,
 * or an identifier that is its own declaration resolves to nothing, and the
 * editor should leave the cursor where it is rather than report a fault.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await request.json().catch(() => null);

  const relPath = typeof body?.path === "string" ? body.path : null;
  const line = Number.isInteger(body?.line) ? (body.line as number) : null;
  const character = Number.isInteger(body?.character)
    ? (body.character as number)
    : null;

  if (!relPath || line === null || line < 1 || character === null || character < 1) {
    return NextResponse.json(
      { error: "A path and a one-based line and character are required." },
      { status: 400 },
    );
  }

  const target = await resolveReviewTarget(id, body?.project ?? null);
  if (!target || !resolveReviewFile(target, relPath)) {
    return NextResponse.json(
      { error: "Not a file in one of this session's projects." },
      { status: 400 },
    );
  }

  try {
    const found = definitionAt({ character, cwd: target.root, file: relPath, line });

    if (!found) {
      return NextResponse.json({ definition: null });
    }

    /*
     * Re-based from the declaration's absolute path onto the session's
     * workspace root — the root the file-content API resolves against, read
     * from the same place it reads it rather than derived by trimming the
     * project prefix off `target.root`.
     *
     * `path: null` when the declaration is outside the workspace entirely,
     * which a dependency installed elsewhere can be. That is honest about
     * there being no workspace-relative name for it, rather than inventing one
     * that would be refused on the way back.
     */
    const { root: workspaceRoot } = await resolveFileRoot(id);
    const path = relativeToWorkspace(workspaceRoot, found.absolute);

    return NextResponse.json({
      definition: { ...found, path },
    });
  } catch (error) {
    // A file outside the TypeScript project, or a project with no tsconfig.
    // Reported as a message rather than a 500, because it is a fact about the
    // file rather than a fault in the request — the same choice the `symbol`
    // route makes.
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to resolve." },
      { status: 422 },
    );
  }
}

/**
 * Workspace-relative form, or null when the path is outside the workspace.
 *
 * `toRelativePath` normalises separators; the `..` test is what makes this a
 * containment check rather than a string trim.
 */
function relativeToWorkspace(
  workspaceRoot: string,
  absolutePath: string,
): string | null {
  const rel = toRelativePath(workspaceRoot, absolutePath);
  return !rel || rel.startsWith("..") ? null : rel;
}
