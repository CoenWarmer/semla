/**
 * Index run progress, as server-sent events.
 *
 * Framed exactly like the terminal and session streams — same `data:` JSON
 * lines, same 30-second keep-alive comment — because the client reads all three
 * with the same `fetch` + `getReader()` loop.
 *
 * A stream rather than a polled status endpoint: an ingest emits a phase change
 * per file and then sits inside one embedding call for seconds at a time.
 * Polling that fast enough to see the chunking phase means most requests learn
 * nothing, and polling slowly means the progress bar jumps from 0 to done.
 *
 * Every run is streamed, not one per connection. The settings panel shows all
 * workspace projects at once, so one connection serves the whole page, and a
 * run started from another tab appears in this one without a refresh.
 */

import { handleRouteError, requireUser } from "@/lib/api-helpers";
import { subscribeToIndexRuns, type IndexRun } from "@/lib/code-index/index-runs";
import {
  encodeSseDataEvent,
  SSE_RESPONSE_HEADERS,
  startSseHeartbeat,
} from "@/lib/sse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Only what the panel renders; the report and root are not the client's business. */
function toEvent(run: IndexRun) {
  return {
    path: run.root,
    running: run.finishedAt === null,
    phase: run.progress.phase,
    done: run.progress.done,
    total: run.progress.total,
    tokens: run.tokens,
    cost: run.cost,
    error: run.error,
    chunks: run.report?.chunksWritten ?? null,
    changed: run.report?.changed ?? null,
  };
}

export async function GET(request: Request) {
  try {
    await requireUser();
  } catch (error) {
    return handleRouteError(error, "Unable to watch index runs.");
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

      const send = (run: IndexRun) => {
        if (closed) return;
        try {
          controller.enqueue(encodeSseDataEvent(toEvent(run)));
        } catch {
          close();
        }
      };

      const { unsubscribe } = subscribeToIndexRuns(send);

      // Proxies and browsers drop a stream that says nothing for long enough,
      // and no project being indexed is the normal state of this page.
      const stopHeartbeat = startSseHeartbeat({
        intervalMs: 30_000,
        isClosed: () => closed,
        enqueue: (chunk) => controller.enqueue(chunk),
        onEnqueueError: close,
      });

      request.signal.addEventListener("abort", () => {
        stopHeartbeat();
        unsubscribe();
        close();
      });
    },
  });

  return new Response(stream, { headers: SSE_RESPONSE_HEADERS });
}
