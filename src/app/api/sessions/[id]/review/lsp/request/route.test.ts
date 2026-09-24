import { describe, expect, it, vi } from "vitest";

/**
 * What reached the language server. Asserted rather than assumed, because the
 * whole point of the trigger-character handling is which `context` goes over
 * the wire: an unadvertised character forwarded as a `TriggerCharacter` kind
 * *panics* TS 7 (`Unknown trigger character: {`), and `{` is exactly what the
 * JSX-prop-value feature sends.
 */
const sendRequest = vi.fn();
const ensureDocumentOpen = vi.fn();

vi.mock("@/lib/pi/browser-lsp/lsp-host", () => ({
  ensureDocumentOpen: (...args: unknown[]) => ensureDocumentOpen(...args),
}));

vi.mock("@/lib/pi/browser-lsp/lsp-request", () => ({
  resolveLspFile: async () => ({
    absolutePath: "/repo/src/a.tsx",
    host: { connection: { sendRequest: (...args: unknown[]) => sendRequest(...args) } },
    uri: "file:///repo/src/a.tsx",
  }),
  workspacePathForLspUri: (uri: string) => uri,
}));

vi.mock("@/lib/pi/workspace/file-browser", () => ({
  resolveFileRoot: async () => ({ root: "/repo" }),
}));

// Ownership is session-auth.ts's concern, tested there; these cover the handler.
vi.mock("@/lib/auth/session-auth", () => ({
  sessionAccessDenied: vi.fn().mockResolvedValue(null),
}));

import { POST } from "./route";

const params = () => Promise.resolve({ id: "session-1" });

const post = (body: unknown) =>
  POST(
    new Request("http://x", {
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    }),
    { params: params() },
  );

const completion = (extra: Record<string, unknown> = {}) => ({
  character: 10,
  line: 3,
  method: "completion",
  path: "src/a.tsx",
  project: "semla",
  ...extra,
});

/** The `context` of the single completion request that was sent. */
const sentContext = () => {
  const call = sendRequest.mock.calls.find(
    ([method]) => method === "textDocument/completion",
  );
  return (call?.[1] as { context?: unknown } | undefined)?.context;
};

describe("POST /api/sessions/[id]/review/lsp/request \u2014 completion", () => {
  it("forwards a trigger character the server advertises", async () => {
    sendRequest.mockReset();
    sendRequest.mockResolvedValue({ isIncomplete: false, items: [] });

    await post(completion({ triggerCharacter: "." }));

    expect(sentContext()).toEqual({ triggerCharacter: ".", triggerKind: 1 });
  });

  /*
   * The case the JSX-prop-value feature depends on. `{` is a *Monaco* trigger
   * character but not a server one, so it must arrive as an explicit invoke:
   * forwarding it would panic the language server mid-session.
   */
  it("downgrades `{` to an explicit invoke rather than forwarding it", async () => {
    sendRequest.mockReset();
    sendRequest.mockResolvedValue({ isIncomplete: false, items: [] });

    await post(completion({ triggerCharacter: "{" }));

    expect(sentContext()).toEqual({ triggerKind: 2 });
  });

  it("downgrades any other unadvertised character too", async () => {
    for (const character of ["}", "(", "=", "\n"]) {
      sendRequest.mockReset();
      sendRequest.mockResolvedValue({ isIncomplete: false, items: [] });

      await post(completion({ triggerCharacter: character }));

      expect(sentContext()).toEqual({ triggerKind: 2 });
    }
  });

  it("sends an explicit invoke when no character is given", async () => {
    sendRequest.mockReset();
    sendRequest.mockResolvedValue({ isIncomplete: false, items: [] });

    await post(completion());

    expect(sentContext()).toEqual({ triggerKind: 2 });
  });

  it("normalises a bare array answer into a list", async () => {
    // LSP permits either shape; TS 7 sends the wrapper, but both must work.
    sendRequest.mockReset();
    sendRequest.mockResolvedValue([{ label: "a" }, { label: "b" }]);

    const res = await post(completion());
    const body = (await res.json()) as {
      result: { isIncomplete: boolean; items: unknown[] };
    };

    expect(body.result.isIncomplete).toBe(false);
    expect(body.result.items).toHaveLength(2);
  });

  it("carries isIncomplete through from the wrapper", async () => {
    sendRequest.mockReset();
    sendRequest.mockResolvedValue({ isIncomplete: true, items: [{ label: "a" }] });

    const res = await post(completion());
    const body = (await res.json()) as { result: { isIncomplete: boolean } };

    expect(body.result.isIncomplete).toBe(true);
  });

  it("treats a null answer as an empty list", async () => {
    sendRequest.mockReset();
    sendRequest.mockResolvedValue(null);

    const res = await post(completion());
    const body = (await res.json()) as { result: { items: unknown[] } };

    expect(body.result.items).toEqual([]);
  });
});

describe("POST \u2026 completionResolve", () => {
  it("requires the item to resolve", async () => {
    sendRequest.mockReset();

    const res = await post({
      method: "completionResolve",
      path: "src/a.tsx",
      project: "semla",
    });

    expect(res.status).toBe(400);
    expect(sendRequest).not.toHaveBeenCalled();
  });

  /*
   * Resolve addresses an item, not a position, so it must not be rejected by
   * the line/character check the other methods need \u2014 and the item has to go
   * over the wire untouched, since its opaque `data` is what the server
   * matches on to produce the import line.
   */
  it("passes the item through verbatim, with no position required", async () => {
    sendRequest.mockReset();
    sendRequest.mockResolvedValue({ label: "X", additionalTextEdits: [] });

    const item = {
      data: { fileName: "/repo/src/a.tsx", name: "X", position: 42 },
      label: "X",
    };
    const res = await post({
      item,
      method: "completionResolve",
      path: "src/a.tsx",
      project: "semla",
    });

    expect(res.status).toBe(200);
    expect(sendRequest).toHaveBeenCalledWith("completionItem/resolve", item);
    // Never opened from disk: resolve must not disturb the open document.
    expect(ensureDocumentOpen).not.toHaveBeenCalled();
  });
});
