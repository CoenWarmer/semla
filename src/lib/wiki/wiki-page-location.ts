/**
 * Where a wiki page's own `.md` file sits, in workspace-relative terms.
 *
 * The vault lives under `WIKI_HOME` (`.semla-wiki` at Semla's own checkout by
 * default — see runtime-config.ts), which is a different coordinate system
 * from the one the Review panel speaks: the panel addresses a file as
 * `{ project, path }`, resolved against `PI_WORKSPACE_ROOT` and a session's
 * attached projects (see `openWorkspacePath` in review-panel.tsx and
 * `splitWorkspacePath` in workspace-path.ts). A wiki page only has a home in
 * that coordinate system when the vault happens to sit inside the workspace
 * root at all — which is the ordinary case for a `next dev` run against
 * Semla's own checkout, and not guaranteed in general (a container-mounted
 * `WIKI_HOME`, or a workspace root that does not contain it).
 *
 * This is the one place that composes the two: given a page id
 * (`folder/slug`), it reports the page's file as a workspace-relative path if
 * one exists — leaving "does this session actually have that project
 * attached" to the caller, the same way `selectionForWorkspacePath` does for
 * Go to Definition.
 */

import { existsSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { PI_WORKSPACE_ROOT, WIKI_HOME } from "@/lib/pi/runtime/runtime-config";

const WIKI_DIR = join(WIKI_HOME, ".llm-wiki", "wiki");

/**
 * `folder/slug`'s absolute `.md` file, translated to a workspace-relative
 * path — or null when the vault sits outside the workspace root, or the page
 * does not exist on disk.
 *
 * Mirrors `getWikiPageContent`'s own path arithmetic (`.replace(/\.\./g, "")`
 * before joining) rather than importing it, because that module also reads
 * the file's content, which this has no need to do.
 */
export function wikiPageWorkspacePath(pageId: string): string | null {
  const normalized = pageId.replaceAll("..", "").replace(/^\/+/, "");
  if (!normalized) return null;

  const absolutePath = join(WIKI_DIR, `${normalized}.md`);
  if (!existsSync(absolutePath)) return null;

  const rel = relative(PI_WORKSPACE_ROOT, absolutePath);
  if (!rel || rel.startsWith("..") || rel.startsWith(sep)) return null;

  return rel.split(sep).join("/");
}
