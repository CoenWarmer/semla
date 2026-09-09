/**
 * The SSE route's own contract, now that a session's stream can outlive the
 * prompt turn that opened it: closing the HTTP response follows the store's
 * own lifetime (`closeSessionStream`), not the *contents* of an event — a
 * "complete" published mid-workflow must not end a connection that a
 * background continuation is still using.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/session-auth", () => ({
  requireSessionOwner: vi.fn().mockResolvedValue({ user: { id: "test-user" } }),
}));

vi.mock("@/lib/pi/session-persistence", () => ({
  setSessionRunning: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/pi/session-service", () => ({
  isSessionActive: vi.fn().mockReturnValue(false),
}));

import {
  closeSessionStream,
  openSessionStream,
  publishToSessionStream,
} from "@/lib/pi/session-stream-store";
import { GET } from "./route";

const sessionId = () => `test-session-${Math.random().toString(36).slice(2)}`;

const readSse = async (response: Response) => {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const events: unknown[] = [];
  let buffer = "";

  const timeout = new Promise<"timeout">((resolve) =>
    setTimeout(() => resolve("timeout"), 500),
  );

  while (true) {
    const result = await Promise.race([reader.read(), timeout]);
    if (result === "timeout") break;
    const { done, value } = result;
    buffer += decoder.decode(value, { stream: !done });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() ?? "";
    for (const chunk of chunks) {
      const data = chunk
        .split("\n")
        .find((line) => line.startsWith("data: "))
        ?.slice(6);
      if (data) events.push(JSON.parse(data));
    }
    if (done) break;
  }

  await reader.cancel().catch(() => {});
  return events;
};

const request = (id: string) =>
  new Request(`http://localhost/api/sessions/${id}/stream`);

describe("GET /api/sessions/[id]/stream", () => {
  it("404s a genuinely inactive session rather than hanging the connection", async () => {
    const id = sessionId();
    // Never opened.

    const response = await GET(request(id), { params: Promise.resolve({ id }) });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ active: false });
  });

  it("forwards a completion event to a subscriber with no poll involved", async () => {
    const id = sessionId();
    openSessionStream(id);

    const response = await GET(request(id), { params: Promise.resolve({ id }) });
    expect(response.status).toBe(200);

    // Published straight into the store — the same call site
    // background-continuation.ts and session-service.ts use, with nothing in
    // between reading a database or a run file.
    publishToSessionStream(id, { runId: "run-1", type: "workflow-started" });
    publishToSessionStream(id, { type: "complete" });
    closeSessionStream(id);

    const events = await readSse(response);
    expect(events).toEqual([
      { runId: "run-1", type: "workflow-started" },
      { type: "complete" },
    ]);
  });

  it("keeps the connection open across a complete event while the store stays open", async () => {
    const id = sessionId();
    openSessionStream(id);

    const response = await GET(request(id), { params: Promise.resolve({ id }) });

    // A "complete" event used to end the HTTP response on sight. It must not
    // any more: a turn that hands off to a background workflow publishes its
    // own "complete" and keeps the store open so the continuation can still
    // report progress on the same connection.
    publishToSessionStream(id, { type: "complete" });
    publishToSessionStream(id, {
      snapshot: { agentCount: 1, doneCount: 0 },
      type: "workflow-snapshot",
    });
    closeSessionStream(id);

    const events = await readSse(response);
    expect(events).toEqual([
      { type: "complete" },
      { snapshot: { agentCount: 1, doneCount: 0 }, type: "workflow-snapshot" },
    ]);
  });

  it("gives a late subscriber the session's current state, not just future events", async () => {
    const id = sessionId();
    openSessionStream(id);

    publishToSessionStream(id, { isRunning: true, type: "session-status" });
    publishToSessionStream(id, {
      snapshot: { agentCount: 2, doneCount: 1 },
      type: "workflow-snapshot",
    });

    // The client attaches only now — a second tab, or a reload mid-run.
    const response = await GET(request(id), { params: Promise.resolve({ id }) });
    closeSessionStream(id);

    const events = await readSse(response);
    expect(events).toEqual([
      { isRunning: true, type: "session-status" },
      { snapshot: { agentCount: 2, doneCount: 1 }, type: "workflow-snapshot" },
    ]);
  });
});
