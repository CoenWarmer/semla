import { realpathSync } from "node:fs";

import { NextResponse } from "next/server";

import { ensureLspHost, subscribeToDiagnostics } from "@/lib/pi/browser-lsp/lsp-host";
import { workspacePathForLspUri } from "@/lib/pi/browser-lsp/lsp-request";
import { resolveFileRoot } from "@/lib/pi/file-browser";
import { resolveReviewTarget } from "@/lib/pi/review/review-service";
import {
  encodeSseDataEvent,
  SSE_RESPONSE_HEADERS,
  startSseHeartbeat,
} from "@/lib/sse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The push half of the bridge: `textDocument/publishDiagnostics`.
 *
 * Everything else the review editor needs from the language server is a
 * request awaiting a response (`request/route.ts`); this is the one thing the
 * server says unprompted, whenever it likes, for any document it has open —
 * so it is the one thing framed as SSE, exactly like the terminal's output
 * stream (`api/terminal/[id]/route.ts`), replay included: a panel that opens
 * after the server has already found problems should see them immediately,
 * not wait for the file to change again.
 *
 * Scoped to a project rather than a file, unlike the other two routes — one
 * subscription covers every document open against that project's host, which
 * is how one editor tab reviewing several files in the same repository is
 * meant to work.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const project = new URL(request.url).searchParams.get("project");

  const target = await resolveReviewTarget(id, project);
  if (!target) {
    return NextResponse.json(
      { error: "Not one of this session's projects." },
      { status: 400 },
    );
  }

  const root = realpathSync(target.root);
  const { root: workspaceRoot } = await resolveFileRoot(id);

  try {
    await ensureLspHost(root);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to start the language server." },
      { status: 502 },
    );
  }

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // Already closed by the other path.
        }
      };

      const send = (uri: string, diagnostics: unknown) => {
        if (closed) return;

        // Workspace-relative, the form `uriForWorkspacePath` in
        // definition-provider.ts already builds a Monaco Uri from — the
        // client has no filesystem access of its own to do this conversion,
        // and every model it holds is keyed the same way.
        const path = workspacePathForLspUri(uri, workspaceRoot);
        if (path === null) return;

        try {
          controller.enqueue(encodeSseDataEvent({ diagnostics, path }));
        } catch {
          close();
        }
      };

      const { ok, unsubscribe } = subscribeToDiagnostics(root, send);
      if (!ok) {
        close();
        return;
      }

      // Proxies and browsers drop a stream that says nothing for long enough,
      // and a project with no fresh diagnostics can go quiet indefinitely.
      const stopHeartbeat = startSseHeartbeat({
        intervalMs: 30_000,
        isClosed: () => closed,
        enqueue: (chunk) => controller.enqueue(chunk),
        onEnqueueError: close,
      });

      const teardown = () => {
        stopHeartbeat();
        unsubscribe();
        close();
      };

      // Detaching does not stop the language server — collapsing the panel
      // should not throw away a running analysis. The host's idle sweep is
      // what eventually reclaims one nobody comes back to.
      request.signal.addEventListener("abort", teardown);
    },
  });

  return new Response(stream, { headers: SSE_RESPONSE_HEADERS });
}
