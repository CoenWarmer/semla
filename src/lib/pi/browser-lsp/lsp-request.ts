/**
 * Resolving a review editor's `{ project, path }` into an LSP host and a
 * document URI.
 *
 * Shared by the three `review/lsp/*` routes so each does not repeat the
 * project lookup and containment check `review/definition/route.ts` already
 * established the shape of — a session can have several projects attached,
 * and a path is only ever addressed relative to one of them.
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { toRelativePath } from "@/lib/pi/file-browser";
import { resolveReviewFile, resolveReviewTarget } from "@/lib/pi/review-service";

import { documentUri, ensureLspHost, type LspHost } from "./lsp-host";

export type ResolvedLspFile = {
  host: LspHost;
  absolutePath: string;
  uri: string;
};

/**
 * The host and document a request addresses, or null when the session has no
 * such project or the path escapes it.
 *
 * Starts the host if none is running yet for this project root — the first
 * hover or the first `didOpen` after a session opens is exactly the moment
 * one is needed, so there is no separate "create" step for a browser to call.
 */
export async function resolveLspFile(
  sessionId: string,
  project: string | null,
  relPath: string,
): Promise<ResolvedLspFile | null> {
  const target = await resolveReviewTarget(sessionId, project);
  if (!target) return null;

  const absolutePath = resolveReviewFile(target, relPath);
  if (!absolutePath) return null;

  // Canonical, matching the key `ensureLspHost` pools on — two projects
  // reached by different symlinks must still share one process.
  const root = realpathSync(target.root);
  const host = await ensureLspHost(root);

  return { absolutePath, host, uri: documentUri(absolutePath) };
}

/**
 * An LSP document URI, re-based onto the session's workspace — the form
 * `definition-provider.ts` and `review/definition/route.ts` already speak, so
 * a location the language server reports can be opened the same way a
 * checker-resolved one is.
 *
 * Null when the URI is not a `file:` URI at all, or names something outside
 * the workspace (a declaration inside `node_modules`, say) — a caller decides
 * whether that is worth telling the operator about; this only reports what it
 * could resolve.
 */
export function workspacePathForLspUri(
  uri: string,
  workspaceRoot: string,
): string | null {
  try {
    const absolutePath = fileURLToPath(uri);
    const rel = toRelativePath(workspaceRoot, absolutePath);
    return !rel || rel.startsWith("..") ? null : rel;
  } catch {
    return null;
  }
}
