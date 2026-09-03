import { NextResponse } from "next/server";

import { enclosingSymbol } from "@/lib/code-map/enclosing";
import { resolveReviewFile, resolveReviewTarget } from "@/lib/pi/review-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Which function a line in a reviewed file is inside.
 *
 * The review editor runs Monaco without a language service, so the browser has
 * the text of a file and none of its meaning. A right-click knows only a line
 * number; naming the function it landed in is a question for the type checker,
 * and this is where it is asked.
 *
 * A null symbol is a successful answer. A line in an import block or a
 * top-level constant is inside no function, and the menu should say so rather
 * than act on the nearest one it could find.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await request.json().catch(() => null);

  const relPath = typeof body?.path === "string" ? body.path : null;
  const line = Number.isInteger(body?.line) ? (body.line as number) : null;

  if (!relPath || line === null || line < 1) {
    return NextResponse.json(
      { error: "A path and a one-based line are required." },
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
    const symbol = enclosingSymbol({ cwd: target.root, file: relPath, line });
    return NextResponse.json({ symbol });
  } catch (error) {
    // A file outside the TypeScript project, or a project with no tsconfig.
    // Reported as a message the menu can show, because it is a fact about the
    // file rather than a fault in the request.
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to resolve." },
      { status: 422 },
    );
  }
}
