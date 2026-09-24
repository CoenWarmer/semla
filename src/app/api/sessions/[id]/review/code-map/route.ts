import { NextResponse } from "next/server";

import { buildCodeMap, SymbolNotFoundError } from "@/lib/code-map/call-graph";
import { enclosingSymbol } from "@/lib/code-map/enclosing";
import { errorFailure, withReviewFile } from "@/lib/pi/review/review-service";
import { sessionAccessDenied } from "@/lib/auth/session-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The call graph around the function at a line, for the editor's context menu.
 *
 * Resolves the symbol and builds the map in one request. Two would be a race:
 * the operator can edit between them, and the second call would then map a
 * function the first had found at a line that has since moved.
 *
 * This calls `buildCodeMap` directly rather than asking the agent to run its
 * `code_map` tool. The map is a fact the type checker produces, so a model
 * round trip would add latency, cost and the possibility of it choosing
 * different arguments — for a menu item whose whole promise is "show me this
 * function", determinism is the feature.
 *
 * `cwd` is the repository root, so the paths in the map come back spelled the
 * same way the panel spells them.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const denied = await sessionAccessDenied(id);
  if (denied) return denied;
  const body = await request.json().catch(() => null);

  const relPath = typeof body?.path === "string" ? body.path : null;
  const line = Number.isInteger(body?.line) ? (body.line as number) : null;

  if (!relPath || line === null || line < 1) {
    return NextResponse.json(
      { error: "A path and a one-based line are required." },
      { status: 400 },
    );
  }

  // Resolves the repository from this session's own links and contains the
  // path inside it, both under the one message: the panel never needed to
  // distinguish "not this session's project" from "not inside it".
  return withReviewFile(
    {
      onFailure: errorFailure({ project: "Not a file in one of this session's projects." }),
      path: relPath,
      project: body?.project ?? null,
      sessionId: id,
    },
    (target) => {
      try {
        const symbol = enclosingSymbol({ cwd: target.root, file: relPath, line });

        if (!symbol) {
          return NextResponse.json({
            error: "That line is not inside a function.",
            map: null,
          });
        }

        const map = buildCodeMap({
          cwd: target.root,
          file: relPath,
          symbol: symbol.symbol,
        });

        return NextResponse.json({ map, symbol });
      } catch (error) {
        // SymbolNotFoundError carries the names that *are* in the file, which is
        // the useful part when a declaration shape the walker missed is the cause.
        const message =
          error instanceof SymbolNotFoundError
            ? error.message
            : error instanceof Error
              ? error.message
              : "Unable to build a code map.";

        return NextResponse.json({ error: message, map: null }, { status: 422 });
      }
    },
  );
}
