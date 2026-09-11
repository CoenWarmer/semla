import { NextResponse } from "next/server";

import {
  closeDocument,
  languageIdForPath,
  openOrChangeDocument,
} from "@/lib/pi/browser-lsp/lsp-host";
import { resolveLspFile } from "@/lib/pi/browser-lsp/lsp-request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Keeping the language server's view of a buffer in sync with Monaco's.
 *
 * Fire-and-forget, unlike `request/route.ts` — these are LSP notifications,
 * which have no response to wait for. `didOpen` and `didChange` are handled
 * identically: `openOrChangeDocument` already tells them apart by whether the
 * document is tracked yet, so there is nothing this route needs the
 * distinction for.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await request.json().catch(() => null);

  const relPath = typeof body?.path === "string" ? body.path : null;
  const method = body?.method;
  const validMethod =
    method === "didOpen" || method === "didChange" || method === "didClose";

  if (!relPath || !validMethod) {
    return NextResponse.json(
      { error: "A path and a recognised method are required." },
      { status: 400 },
    );
  }

  if (method !== "didClose" && typeof body?.text !== "string") {
    return NextResponse.json(
      { error: "didOpen and didChange require the document's text." },
      { status: 400 },
    );
  }

  const file = await resolveLspFile(id, body?.project ?? null, relPath);
  if (!file) {
    return NextResponse.json(
      { error: "Not a file in one of this session's projects." },
      { status: 400 },
    );
  }

  try {
    if (method === "didClose") {
      closeDocument(file.host, file.uri);
    } else {
      openOrChangeDocument(
        file.host,
        file.uri,
        languageIdForPath(file.absolutePath),
        body.text as string,
      );
    }
  } catch (error) {
    // A connection that has already gone — the process crashed, or exited
    // between `resolveLspFile` finding the host and this notification
    // reaching it. Reported rather than left to crash the route: the next
    // `didOpen` for this file starts a fresh host regardless.
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to reach the language server." },
      { status: 502 },
    );
  }

  return NextResponse.json({ ok: true });
}
