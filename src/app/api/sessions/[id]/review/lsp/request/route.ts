import { NextResponse } from "next/server";

import { ensureDocumentOpen } from "@/lib/pi/browser-lsp/lsp-host";
import { resolveLspFile, workspacePathForLspUri } from "@/lib/pi/browser-lsp/lsp-request";
import { resolveFileRoot } from "@/lib/pi/file-browser";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The pull half of the bridge: hover, definition, references and rename, all
 * of which are a single LSP request awaiting a single response — so this is
 * an ordinary POST rather than anything carried over the diagnostics SSE
 * stream. See `lsp-host.ts` for why this talks to a second, Semla-owned
 * `tsc --lsp` process rather than the one supi already runs for the agent.
 *
 * Line and character are one-based, Monaco's convention and this app's own
 * (`review/definition/route.ts` takes the same shape) — converted to LSP's
 * zero-based positions here, at the one seam that has to know both. The
 * response is returned in LSP's own shape, zero-based ranges included: the
 * client already owns turning an LSP answer into a Monaco one for Go to
 * Definition's sibling route, and does the same here in `lsp-provider.ts`.
 */
const METHODS = {
  definition: "textDocument/definition",
  hover: "textDocument/hover",
  prepareRename: "textDocument/prepareRename",
  references: "textDocument/references",
  rename: "textDocument/rename",
} as const;

type Method = keyof typeof METHODS;

function isMethod(value: unknown): value is Method {
  return typeof value === "string" && value in METHODS;
}

type RawLocation = { uri: string; range: unknown };

/**
 * `references` re-based onto the workspace, one entry per location the server
 * found — the same re-basing `review/definition/route.ts` does for a single
 * declaration, done here for a list.
 *
 * A location outside the workspace (inside `node_modules`, say) is dropped
 * rather than reported: there is no model the panel could open it into, and
 * the operator can still see every occurrence this repository owns.
 */
function shapeReferences(result: unknown, workspaceRoot: string) {
  const locations: RawLocation[] = Array.isArray(result)
    ? (result as RawLocation[])
    : result
      ? [result as RawLocation]
      : [];

  return locations
    .map((location) => {
      const path = workspacePathForLspUri(location.uri, workspaceRoot);
      return path === null ? null : { path, range: location.range };
    })
    .filter((entry): entry is { path: string; range: unknown } => entry !== null);
}

type TextDocumentEdit = { textDocument: { uri: string }; edits: unknown[] };
type WorkspaceEdit = {
  changes?: Record<string, unknown[]>;
  documentChanges?: Array<TextDocumentEdit | { kind: string }>;
};

/**
 * `rename` re-based the same way, grouped by file.
 *
 * File-creating, -renaming or -deleting edits inside `documentChanges` are
 * dropped rather than applied: this bridge only ever asks the server to
 * rename a symbol's occurrences, and applying one blind would touch the
 * filesystem in a way the operator never asked the panel to do.
 */
function shapeRename(result: unknown, workspaceRoot: string) {
  const edit = result as WorkspaceEdit | null;
  const entries: Array<{ uri: string; edits: unknown[] }> = [];

  for (const [uri, edits] of Object.entries(edit?.changes ?? {})) {
    entries.push({ edits, uri });
  }
  for (const change of edit?.documentChanges ?? []) {
    if ("textDocument" in change) entries.push({ edits: change.edits, uri: change.textDocument.uri });
  }

  const files = entries
    .map(({ edits, uri }) => {
      const path = workspacePathForLspUri(uri, workspaceRoot);
      return path === null ? null : { edits, path };
    })
    .filter((entry): entry is { path: string; edits: unknown[] } => entry !== null);

  return { files };
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await request.json().catch(() => null);

  const relPath = typeof body?.path === "string" ? body.path : null;
  const rawMethod = body?.method;
  const method = isMethod(rawMethod) ? rawMethod : null;
  const line = Number.isInteger(body?.line) ? (body.line as number) : null;
  const character = Number.isInteger(body?.character)
    ? (body.character as number)
    : null;

  if (!relPath || !method || line === null || line < 1 || character === null || character < 1) {
    return NextResponse.json(
      { error: "A path, a method, and a one-based line and character are required." },
      { status: 400 },
    );
  }

  if (method === "rename" && typeof body?.newName !== "string") {
    return NextResponse.json(
      { error: "Rename requires a newName." },
      { status: 400 },
    );
  }

  const file = await resolveLspFile(id, body?.project ?? null, relPath);
  if (!file) {
    return NextResponse.json(
      { error: "Not a file in one of this session's projects." },
      { status: 400 },
    );
  }

  try {
    await ensureDocumentOpen(file.host, file.absolutePath, file.uri);

    const position = { character: character - 1, line: line - 1 };
    const textDocument = { uri: file.uri };

    const params =
      method === "references"
        ? { context: { includeDeclaration: true }, position, textDocument }
        : method === "rename"
          ? { newName: body.newName as string, position, textDocument }
          : { position, textDocument };

    const result = await file.host.connection.sendRequest(METHODS[method], params);

    if (method === "references" || method === "rename") {
      const { root: workspaceRoot } = await resolveFileRoot(id);
      const shaped =
        method === "references"
          ? shapeReferences(result, workspaceRoot)
          : shapeRename(result, workspaceRoot);
      return NextResponse.json({ result: shaped });
    }

    return NextResponse.json({ result });
  } catch (error) {
    // A language server that has not started, crashed mid-request, or a
    // request it genuinely has nothing to answer (`null` is also a valid,
    // successful LSP response and is not this branch).
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to reach the language server." },
      { status: 502 },
    );
  }
}
