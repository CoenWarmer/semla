import { NextResponse } from "next/server";

import { resolveJsxComponentChain } from "@/lib/code-map/jsx-component";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Hop a chain of component names inward from a resolved boundary file to the
 * innermost one's declaration.
 *
 * The element picker's fallback for the case its debug-stack resolution
 * cannot pass — see `element-locator.ts`'s module doc for why that is the
 * common case, not the exception, for anything deep in a client-rendered
 * tree. Not scoped to a session: unlike `element-target/route.ts`, which
 * attaches a *session's* project, this only reads Semla's own TypeScript
 * project to answer a question about Semla's own source, so there is no
 * session identity for it to belong to.
 *
 * Development only, for the same reason the whole feature is: it depends on
 * being able to build a program for Semla's own checkout, and reads from
 * `process.cwd()` rather than any session-scoped root.
 */
export async function POST(request: Request) {
  if (process.env.NODE_ENV !== "development") {
    return NextResponse.json({ error: "Development only." }, { status: 403 });
  }

  const body = await request.json().catch(() => null);
  const file = typeof body?.file === "string" ? body.file : null;
  const chain = Array.isArray(body?.chain)
    ? body.chain.filter((name: unknown) => typeof name === "string")
    : null;

  if (!file || !chain || chain.length === 0) {
    return NextResponse.json(
      { error: "file and a non-empty chain of component names are required" },
      { status: 400 },
    );
  }

  const located = resolveJsxComponentChain({ chain, file });
  if (!located) {
    return NextResponse.json(
      { error: "None of the chain's names could be resolved from that file." },
      { status: 404 },
    );
  }

  return NextResponse.json(located);
}
