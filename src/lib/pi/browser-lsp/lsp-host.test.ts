/**
 * Driven with a fake `LspConnection` rather than a real `tsc --lsp` process,
 * for the same reason `terminal-store.test.ts` drives itself with a fake pty:
 * the bookkeeping worth pinning down — the registry, the diagnostics replay,
 * and whether a host nobody is watching gets reclaimed — needs no real
 * process to exercise, and a real one would make this slow and occasionally
 * flaky. `lsp-host.integration.test.ts` covers the real thing.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  closeDocument,
  documentUri,
  getLspHost,
  killLspHost,
  languageIdForPath,
  lspHostCount,
  openOrChangeDocument,
  pullDiagnostics,
  pushDiagnostics,
  registerLspHost,
  subscribeToDiagnostics,
  sweepIdleLspHosts,
  type LspConnection,
} from "@/lib/pi/browser-lsp/lsp-host";

/** Any range does, for tests that only care whether a diagnostic round-trips. */
const ZERO_RANGE = { end: { character: 0, line: 0 }, start: { character: 0, line: 0 } };

type FakeConnection = LspConnection & {
  sent: Array<{ method: string; params: unknown }>;
  notificationHandlers: Map<string, (params: unknown) => void>;
  closeHandlers: Array<() => void>;
  disposed: boolean;
  emitClose: () => void;
};

const fakeConnection = (): FakeConnection => {
  const notificationHandlers = new Map<string, (params: unknown) => void>();
  const closeHandlers: Array<() => void> = [];
  return {
    closeHandlers,
    disposed: false,
    dispose: vi.fn(function (this: FakeConnection) {
      this.disposed = true;
    }),
    emitClose() {
      for (const handler of closeHandlers) handler();
    },
    listen: vi.fn(),
    notificationHandlers,
    onClose: vi.fn((handler: () => void) => {
      closeHandlers.push(handler);
    }),
    onNotification: vi.fn((method: string, handler: (params: unknown) => void) => {
      notificationHandlers.set(method, handler);
    }),
    sendNotification: vi.fn(function (
      this: FakeConnection,
      method: string,
      params?: unknown,
    ) {
      this.sent.push({ method, params });
    }),
    sendRequest: vi.fn(async () => null),
    sent: [],
  } as unknown as FakeConnection;
};

/** Drain anything a previous test left behind. */
beforeEach(() => {
  sweepIdleLspHosts(Number.MAX_SAFE_INTEGER, 0);
});

describe("documentUri", () => {
  it("builds a file: URI from an absolute path", () => {
    expect(documentUri("/a/b/c.ts")).toBe("file:///a/b/c.ts");
  });
});

describe("languageIdForPath", () => {
  it("maps each extension this bridge cares about", () => {
    expect(languageIdForPath("a.ts")).toBe("typescript");
    expect(languageIdForPath("a.tsx")).toBe("typescriptreact");
    expect(languageIdForPath("a.js")).toBe("javascript");
    expect(languageIdForPath("a.jsx")).toBe("javascriptreact");
    expect(languageIdForPath("a.mjs")).toBe("javascript");
  });

  it("falls back to typescript for anything else", () => {
    expect(languageIdForPath("a.json")).toBe("typescript");
    expect(languageIdForPath("noextension")).toBe("typescript");
  });
});

describe("registerLspHost", () => {
  it("makes the host findable and starts it idle", () => {
    registerLspHost("/root/a", fakeConnection());

    expect(getLspHost("/root/a")?.root).toBe("/root/a");
    expect(getLspHost("/root/a")?.idleSince).not.toBeNull();
  });

  it("drops the entry when the connection closes", () => {
    const connection = fakeConnection();
    registerLspHost("/root/a", connection);

    connection.emitClose();

    expect(getLspHost("/root/a")).toBeUndefined();
  });

  it("stores diagnostics published under textDocument/publishDiagnostics", () => {
    const connection = fakeConnection();
    const host = registerLspHost("/root/a", connection);

    connection.notificationHandlers.get("textDocument/publishDiagnostics")?.({
      diagnostics: [{ message: "oops", range: ZERO_RANGE }],
      uri: "file:///root/a/x.ts",
    });

    expect(host.diagnostics.get("file:///root/a/x.ts")).toEqual([
      { message: "oops", range: ZERO_RANGE },
    ]);
  });
});

describe("subscribeToDiagnostics", () => {
  it("replays what is already known before sending anything new", () => {
    const host = registerLspHost("/root/a", fakeConnection());
    pushDiagnostics(host, "file:///root/a/x.ts", [{ message: "old", range: ZERO_RANGE }]);

    const seen: Array<[string, unknown]> = [];
    subscribeToDiagnostics("/root/a", (uri, diagnostics) => seen.push([uri, diagnostics]));

    expect(seen).toEqual([["file:///root/a/x.ts", [{ message: "old", range: ZERO_RANGE }]]]);

    pushDiagnostics(host, "file:///root/a/y.ts", [{ message: "new", range: ZERO_RANGE }]);
    expect(seen).toHaveLength(2);
  });

  it("reports a host that is not running", () => {
    const { ok } = subscribeToDiagnostics("/root/missing", () => {});
    expect(ok).toBe(false);
  });

  it("stops the idle clock while somebody is watching, and restarts it after", () => {
    registerLspHost("/root/a", fakeConnection());

    const { unsubscribe } = subscribeToDiagnostics("/root/a", () => {});
    expect(getLspHost("/root/a")?.idleSince).toBeNull();

    unsubscribe();
    expect(getLspHost("/root/a")?.idleSince).not.toBeNull();
  });
});

describe("openOrChangeDocument", () => {
  it("sends didOpen the first time, with version 1", () => {
    const connection = fakeConnection();
    const host = registerLspHost("/root/a", connection);

    openOrChangeDocument(host, "file:///root/a/x.ts", "typescript", "const x = 1;");

    expect(connection.sent).toEqual([
      {
        method: "textDocument/didOpen",
        params: {
          textDocument: {
            languageId: "typescript",
            text: "const x = 1;",
            uri: "file:///root/a/x.ts",
            version: 1,
          },
        },
      },
    ]);
    expect(host.openDocuments.get("file:///root/a/x.ts")).toBe(1);
  });

  it("sends didChange, with an incremented version, on the second call", () => {
    const connection = fakeConnection();
    const host = registerLspHost("/root/a", connection);

    openOrChangeDocument(host, "file:///root/a/x.ts", "typescript", "const x = 1;");
    openOrChangeDocument(host, "file:///root/a/x.ts", "typescript", "const x = 2;");

    expect(connection.sent[1]).toEqual({
      method: "textDocument/didChange",
      params: {
        contentChanges: [{ text: "const x = 2;" }],
        textDocument: { uri: "file:///root/a/x.ts", version: 2 },
      },
    });
    expect(host.openDocuments.get("file:///root/a/x.ts")).toBe(2);
  });
});

describe("pullDiagnostics", () => {
  /**
   * TS 7's `tsc --lsp` advertises `diagnosticProvider` rather than pushing
   * `textDocument/publishDiagnostics`, so this — not the notification handler
   * `registerLspHost` sets up — is what actually reaches it in production.
   * See the doc comment on the real function for how that was found.
   */
  it("stores a full report's items", async () => {
    const connection = fakeConnection();
    connection.sendRequest = vi.fn(async () => ({
      items: [{ message: "oops", range: ZERO_RANGE }],
      kind: "full",
    })) as unknown as LspConnection["sendRequest"];
    const host = registerLspHost("/root/a", connection);

    await pullDiagnostics(host, "file:///root/a/x.ts");

    expect(host.diagnostics.get("file:///root/a/x.ts")).toEqual([
      { message: "oops", range: ZERO_RANGE },
    ]);
  });

  it("leaves whatever is already stored alone for an unchanged report", async () => {
    const connection = fakeConnection();
    const host = registerLspHost("/root/a", connection);
    pushDiagnostics(host, "file:///root/a/x.ts", [{ message: "old", range: ZERO_RANGE }]);

    connection.sendRequest = vi.fn(async () => ({
      kind: "unchanged",
    })) as unknown as LspConnection["sendRequest"];
    await pullDiagnostics(host, "file:///root/a/x.ts");

    expect(host.diagnostics.get("file:///root/a/x.ts")).toEqual([
      { message: "old", range: ZERO_RANGE },
    ]);
  });

  it("does nothing when the server has no diagnosticProvider at all", async () => {
    const connection = fakeConnection();
    connection.sendRequest = vi.fn(async () => {
      throw new Error("Unhandled method textDocument/diagnostic");
    });
    const host = registerLspHost("/root/a", connection);

    await expect(pullDiagnostics(host, "file:///root/a/x.ts")).resolves.toBeUndefined();
    expect(host.diagnostics.has("file:///root/a/x.ts")).toBe(false);
  });
});

describe("closeDocument", () => {
  it("sends didClose and forgets the document's diagnostics", () => {
    const connection = fakeConnection();
    const host = registerLspHost("/root/a", connection);
    openOrChangeDocument(host, "file:///root/a/x.ts", "typescript", "const x = 1;");
    pushDiagnostics(host, "file:///root/a/x.ts", [{ message: "oops", range: ZERO_RANGE }]);

    closeDocument(host, "file:///root/a/x.ts");

    expect(connection.sent.at(-1)).toEqual({
      method: "textDocument/didClose",
      params: { textDocument: { uri: "file:///root/a/x.ts" } },
    });
    expect(host.openDocuments.has("file:///root/a/x.ts")).toBe(false);
    expect(host.diagnostics.has("file:///root/a/x.ts")).toBe(false);
  });

  it("does nothing for a document that was never open", () => {
    const connection = fakeConnection();
    const host = registerLspHost("/root/a", connection);

    closeDocument(host, "file:///root/a/never.ts");

    expect(connection.sent).toEqual([]);
  });
});

describe("killLspHost", () => {
  it("disposes the connection and forgets the host", () => {
    const connection = fakeConnection();
    registerLspHost("/root/a", connection);

    expect(killLspHost("/root/a")).toBe(true);
    expect(connection.disposed).toBe(true);
    expect(getLspHost("/root/a")).toBeUndefined();
  });

  it("says so when there is nothing to kill", () => {
    expect(killLspHost("/root/missing")).toBe(false);
  });

  it("still forgets a host whose dispose throws", () => {
    const connection = fakeConnection();
    connection.dispose = vi.fn(() => {
      throw new Error("already gone");
    });
    registerLspHost("/root/a", connection);

    expect(killLspHost("/root/a")).toBe(true);
    expect(getLspHost("/root/a")).toBeUndefined();
  });
});

describe("sweepIdleLspHosts", () => {
  it("reclaims one nobody has watched for long enough", () => {
    const connection = fakeConnection();
    registerLspHost("/root/a", connection);

    const killed = sweepIdleLspHosts(Date.now() + 60 * 60_000);

    expect(killed).toBe(1);
    expect(connection.disposed).toBe(true);
    expect(lspHostCount()).toBe(0);
  });

  it("leaves one that is being watched, however long it has been open", () => {
    registerLspHost("/root/a", fakeConnection());
    subscribeToDiagnostics("/root/a", () => {});

    expect(sweepIdleLspHosts(Date.now() + 24 * 60 * 60_000)).toBe(0);
    expect(getLspHost("/root/a")).toBeDefined();
  });
});
