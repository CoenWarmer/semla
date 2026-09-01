import { handleRouteError, requireUser } from "@/lib/api-helpers";
import {
  getTerminal,
  killTerminal,
  subscribeToTerminal,
} from "@/lib/pi/terminal-store";
import { parseTerminalControl } from "@/lib/terminal-control";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const encoder = new TextEncoder();

/**
 * A terminal's output, as server-sent events.
 *
 * Framed exactly like the session stream (`sessions/[id]/stream/route.ts`),
 * including the keep-alive comment, because the client reads both with the same
 * `fetch` + `getReader()` loop. Attaching replays the scrollback first, so
 * reopening the bar shows the shell as it was rather than an empty pane.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    await requireUser();
  } catch (error) {
    return handleRouteError(error, "Unable to attach to the terminal.");
  }

  if (!getTerminal(id)) {
    return Response.json({ error: "No such terminal." }, { status: 404 });
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

      const send = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ data: chunk })}\n\n`),
          );
        } catch {
          close();
        }
      };

      const { ok, unsubscribe } = subscribeToTerminal(id, send);
      if (!ok) {
        close();
        return;
      }

      // Proxies and browsers drop a stream that says nothing for long enough,
      // and a shell sitting at a prompt says nothing indefinitely.
      const heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(": keep-alive\n\n"));
        } catch {
          close();
        }
      }, 30_000);

      const teardown = () => {
        clearInterval(heartbeat);
        unsubscribe();
        close();
      };

      // Detaching does not kill the shell — collapsing the bar should not throw
      // away what you were doing. The store's idle sweep is what eventually
      // reclaims one nobody comes back to.
      request.signal.addEventListener("abort", teardown);
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

/**
 * Everything the browser sends *to* a terminal: keystrokes, a new size, or a
 * request to end it.
 *
 * One endpoint rather than three, mirroring the prompt/stop split elsewhere:
 * the message is parsed by `parseTerminalControl`, which is the only thing that
 * decides what may reach `pty.write` and `pty.resize`.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    await requireUser();

    const control = parseTerminalControl(await request.json().catch(() => null));
    if (!control) {
      return Response.json({ error: "Unrecognised control." }, { status: 400 });
    }

    if (control.type === "kill") {
      return Response.json({ killed: killTerminal(id) });
    }

    const session = getTerminal(id);
    if (!session) {
      return Response.json({ error: "No such terminal." }, { status: 404 });
    }

    if (control.type === "input") {
      session.pty.write(control.data);
    } else {
      session.pty.resize(control.cols, control.rows);
    }

    return Response.json({ ok: true });
  } catch (error) {
    return handleRouteError(error, "Unable to reach the terminal.");
  }
}
