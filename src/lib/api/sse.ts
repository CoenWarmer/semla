const encoder = new TextEncoder();

/** Pre-encoded `: keep-alive\n\n` comment frame shared by every SSE route. */
export const SSE_KEEP_ALIVE_BYTES = encoder.encode(": keep-alive\n\n");

/** Response headers identical across all server-sent event routes. */
export const SSE_RESPONSE_HEADERS = {
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "Content-Type": "text/event-stream",
} as const;

/** `data: ${JSON.stringify(data)}\n\n` as UTF-8 bytes. */
export function encodeSseDataEvent(data: unknown): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(data)}\n\n`);
}

/**
 * Periodic keep-alive comment frames. Returns a stop function that clears the
 * timer. `onEnqueueError` is omitted on routes that silently drop a dead client.
 */
export function startSseHeartbeat(options: {
  intervalMs: number;
  isClosed: () => boolean;
  enqueue: (chunk: Uint8Array) => void;
  onEnqueueError?: () => void;
}): () => void {
  const interval = setInterval(() => {
    if (options.isClosed()) return;
    try {
      options.enqueue(SSE_KEEP_ALIVE_BYTES);
    } catch {
      options.onEnqueueError?.();
    }
  }, options.intervalMs);

  return () => clearInterval(interval);
}
