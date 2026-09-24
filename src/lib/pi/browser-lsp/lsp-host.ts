/**
 * The TypeScript language server processes the review editor talks to.
 *
 * Shaped after `terminal-store.ts`, which solves the same problem for
 * `node-pty` shells: an in-process map, and a subscribe that replays what is
 * already known before attaching — here that is a document's most recent
 * diagnostics rather than a shell's scrollback.
 *
 * **This is a second, Semla-owned language server, not the one `@mrclrchtr/
 * supi-code-intelligence` already runs for the agent's own tools.** That one
 * exists — `language-servers.ts` puts the same `typescript-language-server`
 * shim on PATH that this module spawns — but its `LspManager` and the
 * `JsonRpcClient` wrapping its child process are private to
 * `@mrclrchtr/supi-lsp`'s internals, with no exported handle for another part
 * of this application to attach to. A browser bridge needs its own instance.
 *
 * Pooled by canonical project root rather than by browser tab or session: two
 * review panels open on the same repository — in different tabs, or from
 * different sessions anchored to it — share one `tsc --lsp` process, the same
 * choice supi's own `WorkspaceProviderHost` makes for the agent-side server.
 *
 * Idle bookkeeping follows the diagnostics subscription, exactly as
 * `terminal-store.ts` follows a terminal's output subscribers: a host with
 * nobody listening for diagnostics starts an idle clock, and the sweep is what
 * reclaims one whose tab closed without saying so.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node";
import {
  DidChangeTextDocumentNotification,
  DidCloseTextDocumentNotification,
  DidOpenTextDocumentNotification,
  DocumentDiagnosticReportKind,
  DocumentDiagnosticRequest,
  InitializedNotification,
  InitializeRequest,
  PublishDiagnosticsNotification,
  type Diagnostic,
  type DocumentDiagnosticReport,
} from "vscode-languageserver-protocol/node";

/** How long a host may sit with nobody watching its diagnostics before it is killed. */
export const IDLE_TIMEOUT_MS = 15 * 60_000;

/**
 * The subset of `vscode-jsonrpc`'s `MessageConnection` this module uses.
 *
 * Named locally, rather than importing `MessageConnection` itself, so a test
 * can hand in a fake that implements exactly this and nothing else — a real
 * connection satisfies it for free, since TypeScript structural typing does
 * not require the fake to claim the whole interface.
 */
export interface LspConnection {
  sendRequest<R>(method: string, params?: unknown): Promise<R>;
  sendNotification(method: string, params?: unknown): void;
  onNotification(method: string, handler: (params: unknown) => void): void;
  onClose(handler: () => void): void;
  listen(): void;
  dispose(): void;
}

export type DiagnosticsSubscriber = (uri: string, diagnostics: Diagnostic[]) => void;

export type LspHost = {
  /** Canonical (realpath'd) project root this host was started for. */
  root: string;
  connection: LspConnection;
  /** Open document versions, for `didChange`'s required monotonic counter. */
  openDocuments: Map<string, number>;
  /** The last diagnostics reported per open document, replayed on subscribe. */
  diagnostics: Map<string, Diagnostic[]>;
  subscribers: Set<DiagnosticsSubscriber>;
  /** When the last diagnostics subscriber left, or null while somebody is watching. */
  idleSince: number | null;
  exited: boolean;
};

/**
 * Survives the module reload `next dev` performs on every edit. Without this,
 * each reload starts an empty map while the servers from the previous one keep
 * running with nothing able to reach or kill them.
 */
const globalStore = globalThis as unknown as {
  __semlaLspHosts?: Map<string, LspHost>;
};

const hosts = (globalStore.__semlaLspHosts ??= new Map());

export function getLspHost(root: string): LspHost | undefined {
  return hosts.get(root);
}

export function lspHostCount(): number {
  return hosts.size;
}

/** LSP's document URI for a file on disk. */
export function documentUri(absolutePath: string): string {
  return pathToFileURL(absolutePath).toString();
}

/**
 * Record diagnostics for one document and fan them out.
 *
 * Exported for the pool's own tests, which drive it with a fake connection
 * rather than a real language server.
 */
export function pushDiagnostics(
  host: LspHost,
  uri: string,
  diagnostics: Diagnostic[],
): void {
  host.diagnostics.set(uri, diagnostics);
  for (const subscriber of host.subscribers) subscriber(uri, diagnostics);
}

/**
 * Register an already-connected host in the pool.
 *
 * Split from `startLspHost` below so a test can register a fake connection
 * without spawning a real process — the registry and its bookkeeping are what
 * is worth pinning down; a real `tsc --lsp` child belongs in an integration
 * test instead.
 */
export function registerLspHost(root: string, connection: LspConnection): LspHost {
  const host: LspHost = {
    connection,
    diagnostics: new Map(),
    exited: false,
    idleSince: Date.now(),
    openDocuments: new Map(),
    root,
    subscribers: new Set(),
  };

  hosts.set(root, host);

  connection.onNotification(PublishDiagnosticsNotification.method, (params) => {
    const { uri, diagnostics } = params as {
      uri: string;
      diagnostics: Diagnostic[];
    };
    pushDiagnostics(host, uri, diagnostics);
  });

  connection.onClose(() => {
    host.exited = true;
    hosts.delete(root);
  });

  return host;
}

/**
 * Attach to a host's diagnostics, receiving what is already known first.
 *
 * The replay is the point, as in `subscribeToTerminal`: a subscriber that only
 * saw new notifications would show a clean file for every document that
 * hasn't changed since the panel opened, rather than whatever the server
 * reported the last time it looked.
 */
export function subscribeToDiagnostics(
  root: string,
  onDiagnostics: DiagnosticsSubscriber,
): { unsubscribe: () => void; ok: boolean } {
  const host = hosts.get(root);
  if (!host) return { ok: false, unsubscribe: () => {} };

  for (const [uri, diagnostics] of host.diagnostics) onDiagnostics(uri, diagnostics);
  host.subscribers.add(onDiagnostics);
  host.idleSince = null;

  return {
    ok: true,
    unsubscribe: () => {
      host.subscribers.delete(onDiagnostics);
      if (host.subscribers.size === 0) host.idleSince = Date.now();
    },
  };
}

export function killLspHost(root: string): boolean {
  const host = hosts.get(root);
  if (!host) return false;

  hosts.delete(root);
  try {
    host.connection.dispose();
  } catch {
    // Already gone. The entry is removed either way, which is what matters.
  }
  return true;
}

/**
 * Kill hosts nobody has watched for a while.
 *
 * A tab that closes without saying so — a crashed page, a lost network —
 * otherwise leaves a `tsc --lsp` process running until the server stops.
 */
export function sweepIdleLspHosts(
  now = Date.now(),
  timeoutMs = IDLE_TIMEOUT_MS,
): number {
  let killed = 0;
  for (const [root, host] of hosts) {
    if (host.idleSince !== null && now - host.idleSince >= timeoutMs) {
      killLspHost(root);
      killed += 1;
    }
  }
  return killed;
}

/**
 * Ask the server for a document's diagnostics and store what it says.
 *
 * TS 7's `tsc --lsp` is why this exists at all: its `initialize` response
 * advertises `diagnosticProvider` rather than pushing
 * `textDocument/publishDiagnostics` unprompted — LSP 3.17's *pull* model, one
 * request per document, not the older server-initiated push most language
 * servers still default to. `registerLspHost` still listens for a push, for
 * any future server behind this bridge that sends one; TS 7 needs a pull
 * after every `didOpen`/`didChange`, which is what `openOrChangeDocument`
 * below does.
 *
 * `unchanged` — the report kind meaning "still whatever you last stored" — is
 * not an error and not a reason to touch `host.diagnostics`; only `full`
 * replaces it.
 */
export async function pullDiagnostics(host: LspHost, uri: string): Promise<void> {
  try {
    const report = await host.connection.sendRequest<DocumentDiagnosticReport>(
      DocumentDiagnosticRequest.method,
      { textDocument: { uri } },
    );
    if (report.kind === DocumentDiagnosticReportKind.Full) {
      pushDiagnostics(host, uri, report.items);
    }
  } catch {
    // A server with no diagnosticProvider at all, or one that has not
    // finished starting up yet. The panel simply shows nothing new until the
    // next open or edit tries again.
  }
}

/**
 * Open a document, or update it if it is already open.
 *
 * Full-document sync throughout this module rather than incremental ranges:
 * the operator's edits are already in the browser's own model, so there is no
 * saving on wire size that is worth the bug surface of computing deltas
 * server-side from a diff of two full texts.
 */
export function openOrChangeDocument(
  host: LspHost,
  uri: string,
  languageId: string,
  text: string,
): void {
  const version = host.openDocuments.get(uri);

  if (version === undefined) {
    host.openDocuments.set(uri, 1);
    host.connection.sendNotification(DidOpenTextDocumentNotification.method, {
      textDocument: { languageId, text, uri, version: 1 },
    });
  } else {
    const next = version + 1;
    host.openDocuments.set(uri, next);
    host.connection.sendNotification(DidChangeTextDocumentNotification.method, {
      contentChanges: [{ text }],
      textDocument: { uri, version: next },
    });
  }

  // Not awaited: the notification above is what the LSP spec requires before
  // asking, but the ask itself is a second round trip nothing here needs to
  // block on — the diagnostics subscriber sees the answer when it arrives.
  void pullDiagnostics(host, uri);
}

export function closeDocument(host: LspHost, uri: string): void {
  if (!host.openDocuments.delete(uri)) return;
  host.diagnostics.delete(uri);
  host.connection.sendNotification(DidCloseTextDocumentNotification.method, {
    textDocument: { uri },
  });
}

/** LSP's `languageId`, by extension. TS/JS only — the one server this bridges to. */
export function languageIdForPath(path: string): string {
  const extension = path.toLowerCase().split(".").pop() ?? "";
  const byExtension: Record<string, string> = {
    cjs: "javascript",
    cts: "typescript",
    js: "javascript",
    jsx: "javascriptreact",
    mjs: "javascript",
    mts: "typescript",
    ts: "typescript",
    tsx: "typescriptreact",
  };
  return byExtension[extension] ?? "typescript";
}

/**
 * Open a document from disk if a request arrives before the browser's own
 * `didOpen` — a hover fired the instant a file is selected can race the
 * notify call the panel sends alongside it.
 */
export async function ensureDocumentOpen(
  host: LspHost,
  absolutePath: string,
  uri: string,
): Promise<void> {
  if (host.openDocuments.has(uri)) return;
  const text = await readFile(absolutePath, "utf8");
  openOrChangeDocument(host, uri, languageIdForPath(absolutePath), text);
}

/**
 * Spawn `typescript-language-server` for a project root and complete the
 * `initialize`/`initialized` handshake.
 *
 * Relies on the shim directory `language-servers.ts` puts on `PATH` at boot
 * (`ensureLanguageServersOnPath`, called from `instrumentation.ts`) resolving
 * `typescript-language-server` to TS 7's `tsc --lsp -stdio` — the same
 * resolution the agent-side server uses, just a second process.
 */
export async function spawnLspConnection(root: string): Promise<LspConnection> {
  const child: ChildProcessWithoutNullStreams = spawn(
    "typescript-language-server",
    ["--stdio"],
    { cwd: root, stdio: ["pipe", "pipe", "pipe"] },
  );

  const connection = createMessageConnection(
    new StreamMessageReader(child.stdout),
    new StreamMessageWriter(child.stdin),
  );

  connection.listen();
  child.on("exit", () => connection.dispose());

  try {
    await connection.sendRequest(InitializeRequest.method, {
      capabilities: {
        textDocument: {
          /*
           * Two fields here are load-bearing rather than declarative.
           *
           * `labelDetails` is how TS 7 reports the module an auto-import would
           * come from (`labelDetails.description`) on the *unresolved* item.
           * Without it the suggestion list has no way to show that accepting
           * an item will also add an import, because the resolved `detail`
           * that says so in words is one round trip later.
           *
           * `resolveSupport` names the properties this client is prepared to
           * receive from `completionItem/resolve`, and `additionalTextEdits`
           * is the import line itself. A server is entitled to withhold what
           * the client has not asked for.
           *
           * `snippetSupport` stays false: Monaco can apply a snippet (see
           * `snippetController2` in `monaco-setup.ts`) but nothing this
           * feature covers needs one, and a plain-text answer is one less
           * shape for `completionInsertText` to get wrong.
           */
          completion: {
            completionItem: {
              labelDetailsSupport: true,
              resolveSupport: {
                properties: ["additionalTextEdits", "detail", "documentation"],
              },
              snippetSupport: false,
            },
            contextSupport: true,
            dynamicRegistration: false,
          },
          definition: { dynamicRegistration: false },
          hover: { contentFormat: ["markdown", "plaintext"], dynamicRegistration: false },
          publishDiagnostics: { relatedInformation: true },
          references: { dynamicRegistration: false },
          rename: { dynamicRegistration: false, prepareSupport: true },
        },
      },
      processId: process.pid,
      rootUri: documentUri(root),
      workspaceFolders: [{ name: root, uri: documentUri(root) }],
    });
  } catch (error) {
    // The handshake itself failed — the binary is missing, or the process
    // died before answering. Without this the child leaks: nothing else
    // holds a reference to kill it, since it never made it into the pool.
    connection.dispose();
    child.kill();
    throw error;
  }
  // `initialized` has nothing to wait for — it is the one notification LSP
  // requires after a successful `initialize`, not a request with an answer.
  void connection.sendNotification(InitializedNotification.method, {});

  return connection;
}

/**
 * The host for a project root, starting one if none is running.
 *
 * The one entry point route handlers call — they do not distinguish "already
 * running" from "just started"; both hand back a host ready to take requests.
 */
export async function ensureLspHost(root: string): Promise<LspHost> {
  const existing = hosts.get(root);
  if (existing && !existing.exited) return existing;

  sweepIdleLspHosts();

  const connection = await spawnLspConnection(root);
  return registerLspHost(root, connection);
}
