/**
 * A rehype plugin that defuses `rehype-harden` for links whose `href` is a
 * repo-relative source file reference, rather than letting harden block
 * them.
 *
 * Streamdown's default `harden` plugin (see
 * `streamdown-rehype-plugins.md`/`markdown-paragraph.tsx`) only tolerates an
 * `<a>` `href` that parses as an absolute URL or as `/`, `./`, `../` —
 * `rehype-harden`'s own `parseUrl` returns `null` for anything else, and a
 * bare `src/lib/foo.ts` is exactly that shape. The result is not "left
 * alone": harden replaces the whole `<a>` with a `<span>` carrying the
 * link's text plus a literal `" [blocked]"` suffix — a chat message that
 * writes `[Foo](src/lib/foo.ts)`, a form models are told to use for
 * cross-references, renders as "Foo [blocked]" with no way to open the
 * file.
 *
 * This plugin has to run *before* harden in the rehype pipeline: harden
 * decides purely from `properties.href`, so by the time it sees the node
 * the only way to keep it from blocking is to have already turned it into
 * something harden's own `a`/`img` checks do not match at all. Rewriting
 * such a link into a neutral `<span>` — before harden runs — does that:
 * harden's visitor only special-cases `tagName === "a"` and
 * `tagName === "img"`, so a `span` passes through untouched regardless of
 * its `href`-shaped data attributes.
 *
 * The emitted `span` carries `data-file-link`, `data-file-path`, and
 * (optionally) `data-file-line` — plain `data-*` attributes, which
 * `rehype-sanitize`'s default schema strips from `span` same as any other
 * unlisted attribute, so this only works paired with a `sanitize` schema
 * that allows them (see `sanitizeSchemaWithFileLinks` in this module) fed
 * to the `sanitize` plugin still ahead of both of us. `message.tsx`'s
 * `components` map reads those attributes to render a clickable button —
 * see `clickable-file-path.tsx`, whose click-resolution logic this reuses
 * rather than duplicating (`resolveMarkdownFileLinkHref`).
 *
 * A link left untouched by this plugin — a real URL, `javascript:`,
 * `data:`, an absolute path, anything `parseFilePathToken` rejects — is not
 * modified at all, so harden's existing security behaviour for it is
 * exactly what it was before this plugin existed.
 */

import type { Element, ElementContent, Root, RootContent } from "hast";

import { parseFilePathToken } from "@/lib/file-path-token";

/** Marks a `span` this plugin emitted, for `message.tsx`'s components map to key on. */
export const FILE_LINK_MARKER = "file-link";

/**
 * `data-*` attributes rehype-sanitize must allow on `span` for the emitted
 * elements to survive sanitization. Spread into a sanitize schema's
 * `attributes.span` list alongside whatever it already allows.
 */
export const FILE_LINK_SPAN_ATTRIBUTES = [
  "dataFileLink",
  "dataFilePath",
  "dataFileLine",
] as const;

/**
 * Strips a single leading `./`, the one relative-path prefix models
 * sometimes emit that `parseFilePathToken` otherwise rejects outright (it
 * treats any leading `.` as an absolute-path-style climb). Anything else —
 * `../`, a genuine absolute path — is left for `parseFilePathToken` to
 * reject on its own terms.
 */
function stripLeadingDotSlash(href: string): string {
  return href.startsWith("./") ? href.slice(2) : href;
}

/**
 * Whether `href` names a repo-relative source file this plugin should
 * rewrite, and the parsed path/line if so. Exported for the components map
 * and tests to share the exact same accept rule this plugin used.
 */
export function parseFileLinkHref(
  href: string,
): { rawPath: string; line: number | null } | null {
  return parseFilePathToken(stripLeadingDotSlash(href));
}

function isElement(node: RootContent | ElementContent): node is Element {
  return node.type === "element";
}

function rewriteIfFileLink(node: Element): void {
  const href = node.properties.href;
  if (node.tagName !== "a" || typeof href !== "string") return;

  const token = parseFileLinkHref(href);
  if (!token) return;

  node.tagName = "span";
  node.properties = {
    dataFileLink: FILE_LINK_MARKER,
    dataFilePath: token.rawPath,
    ...(token.line !== null ? { dataFileLine: token.line } : {}),
  };
}

/** Recurses into every element in the tree, rewriting file-link anchors in place. */
function walk(node: Root | Element): void {
  for (const child of node.children) {
    if (!isElement(child)) continue;
    rewriteIfFileLink(child);
    walk(child);
  }
}

/**
 * Rehype plugin: rewrites `<a>` elements whose `href` is a repo-relative
 * source file reference into a neutral `<span>` carrying the parsed path
 * (and line, if any) as data attributes, before `rehype-harden` gets a
 * chance to block them as an unrecognized relative URL.
 */
export function rehypeFileLinks() {
  return (tree: Root) => {
    walk(tree);
  };
}
