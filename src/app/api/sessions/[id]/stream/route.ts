import { handleRouteError } from "@/lib/api-helpers";
import { requireSessionOwner } from "@/lib/session-auth";
import {
  isSessionStreamActive,
  subscribeToSessionStream,
} from "@/lib/pi/session-stream-store";
import { createAdminClient } from "@/lib/supabase-admin";

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
    // Stream not found — either already finished or server restarted.
    // Clear a potentially stale is_running flag from a server restart.
    const admin = createAdminClient();
    await admin
      .from("sessions")
      .update({ is_running: false })
      .eq("id", id)
      .eq("is_running", true);

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
