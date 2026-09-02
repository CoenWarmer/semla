import { handleRouteError } from "@/lib/api-helpers";
import { requireSessionOwner } from "@/lib/session-auth";
import {
  isSessionStreamActive,
  subscribeToSessionStream,
} from "@/lib/pi/session-stream-store";
import { setSessionRunning } from "@/lib/pi/session-persistence";
import { isSessionActive } from "@/lib/pi/session-service";

export const runtime = "nodejs";

const encoder = new TextEncoder();

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    await requireSessionOwner(id);
  } catch (error) {
    return handleRouteError(error, "Unable to authorize session.");
  }

  if (!isSessionStreamActive(id)) {
    // No stream to attach to — but that is not the same as nothing running.
    //
    // A prompt turn that started a background workflow closes its stream and
    // then hands off to runBackgroundContinuation, which keeps working and
    // delivers a report turn later. The client reconnects the moment the turn's
    // stream ends, lands here, and used to have the running flag cleared out
    // from under it — so the sidebar spinner and the prompt bar both went idle
    // while four subagents were still going, and nothing turned them back on.
    //
    // isSessionActive is the honest test: a live session or an armed
    // continuation. It is false after a restart, which is the stale-flag case
    // this clearing exists for, and it stays false there.
    //
    // Through setSessionRunning rather than a direct Supabase update: the flag
    // lives in two places and the status poll reads the *disk* record, so
    // updating only the database left the poll still reporting a turn that had
    // demonstrably ended — and the client, trusting it, asking again.
    if (!isSessionActive(id)) await setSessionRunning(id, false);

    return Response.json({ active: false }, { status: 404 });
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
          // already closed
        }
      };

      const send = (event: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
          );
        } catch {
          // client disconnected
        }
      };

      const heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(": keep-alive\n\n"));
        } catch {
          // client disconnected
        }
      }, 30_000);

      const { unsubscribe } = subscribeToSessionStream(id, (event) => {
        send(event);
        const e = event as Record<string, unknown>;
        if (e.type === "complete" || e.type === "error") {
          clearInterval(heartbeat);
          unsubscribe();
          close();
        }
      });

      request.signal.addEventListener("abort", () => {
        clearInterval(heartbeat);
        unsubscribe();
        close();
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream",
    },
  });
}
