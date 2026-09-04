import { Children, isValidElement, type ReactNode } from "react";
import { defaultRehypePlugins } from "streamdown";

/**
 * A markdown paragraph that does not put a `<div>` inside a `<p>`.
 *
 * Streamdown renders an image as `<div data-streamdown="image-wrapper">`, and
 * a `<div>` is not valid inside a `<p>` — React reports it as a hydration
 * error, because the browser's parser closes the `<p>` early and the server
 * and client then disagree about the tree.
 *
 * Streamdown knows this and guards for it, but only when the image is the
 * paragraph's *sole* child. Markdown puts an image in a paragraph with
 * anything adjacent to it, and a soft line break is enough:
 *
 *     **1. Red Panda**
 *     ![Red Panda](https://…)
 *
 * is one paragraph of `strong`, `br`, `img` — three children, so the guard
 * misses. Confirmed against streamdown 2.5.0 and 2.6.0, which have the same
 * `children.length === 1` test and the same `div` wrapper, so this is not
 * waiting on an upgrade.
 *
 * Widened here: the sole-child case still collapses to a fragment, matching
 * upstream, and a paragraph that mixes an image with other content becomes a
 * `div` carrying the same props — valid, and keeps the paragraph's styling,
 * which a fragment would drop.
 */

/** What a paragraph's children require it to be rendered as. */
export type ParagraphTag = "div" | "fragment" | "p";

/**
 * Block-level in Streamdown's rendering, whatever markdown thinks: an image
 * (a `div` wrapper) and a fenced code block (which it marks `data-block`).
 */
const rendersAsBlock = (child: ReactNode): boolean => {
  if (!isValidElement(child)) return false;

  const props = child.props as {
    node?: { tagName?: string };
    ["data-block"]?: unknown;
  };
  const tag = props.node?.tagName;

  if (tag === "img") return true;
  return tag === "code" && "data-block" in props;
};

export const paragraphTagFor = (children: ReactNode): ParagraphTag => {
  // Same filter as upstream: whitespace-only text between two elements is not
  // a child for this purpose, or every image on its own line would count as
  // mixed content.
  const meaningful = Children.toArray(children).filter(
    (child) => child !== null && child !== undefined && child !== "",
  );

  if (!meaningful.some(rendersAsBlock)) return "p";
  // One block and nothing else needs no wrapper at all, which is what
  // Streamdown does today.
  return meaningful.length === 1 ? "fragment" : "div";
};

export type MarkdownParagraphProps = {
  children?: ReactNode;
  /** react-markdown's AST node. Not a DOM attribute, so never spread. */
  node?: unknown;
};

export const MarkdownParagraph = ({
  children,
  node: _node,
  ...props
}: MarkdownParagraphProps) => {
  const tag = paragraphTagFor(children);

  if (tag === "fragment") return <>{children}</>;
  if (tag === "div") return <div {...props}>{children}</div>;
  return <p {...props}>{children}</p>;
};

/**
 * Every default Streamdown rehype plugin except `raw`, for every place this
 * app renders a message or reasoning trace as markdown.
 *
 * Streamdown's default `rehypePlugins` include `rehype-raw`, which parses
 * literal HTML written in text as real elements rather than escaping it —
 * so a message that happens to contain the text `<p>...</p>` (someone
 * pasting an error message, an HTML snippet, anything with angle brackets)
 * renders an actual nested `<p>` inside the paragraph markdown already wraps
 * it in. That is invalid HTML, and React reports it as a hydration mismatch
 * because the browser's parser closes the outer `<p>` early while the
 * server-rendered tree still has it open — the same class of bug this
 * file's `MarkdownParagraph` fixes for images, just triggered by prose
 * instead of markdown syntax.
 *
 * Streamdown ships its own fix for exactly this — a remark plugin that
 * converts raw HTML nodes to plain text instead of parsing them — but only
 * auto-adds it when `rehype-raw` is *not* among the configured
 * `rehypePlugins`. Passing the defaults minus `raw` is what triggers that,
 * confirmed by reading the package's own bundle: it adds the text-conversion
 * plugin exactly when `rehype-raw` is absent from the list. `sanitize` and
 * `harden` still run — they matter for markdown-generated elements (links,
 * images) regardless of raw HTML, so nothing else is lost.
 */
export const STREAMDOWN_REHYPE_PLUGINS_WITHOUT_RAW = Object.entries(
  defaultRehypePlugins,
)
  .filter(([name]) => name !== "raw")
  .map(([, plugin]) => plugin);
