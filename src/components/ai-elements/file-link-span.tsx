"use client";

/**
 * Renderer for the `<span data-file-link="file-link" ...>` elements
 * `rehypeFileLinks` (see `@/lib/markdown/rehype-file-links`) rewrites
 * markdown links into, in place of the `<a>` that `rehype-harden` would
 * otherwise replace with a `" [blocked]"` indicator.
 *
 * Resolution and click behaviour are identical to `ClickableFilePathCode`'s
 * — both go through `useFileTargetClick` — so a link that does not resolve
 * against the session's attached projects (no project attached, or an
 * ambiguous multi-project session) renders as plain text with the link's
 * original wording, exactly like the inline-code case falls back to plain
 * `<code>`.
 */

import type { ReactNode } from "react";
import { useMemo } from "react";

import { cn } from "@/lib/utils";

import { useFileTargetClick } from "./use-file-target-click";

type FileLinkSpanProps = {
  children?: ReactNode;
  className?: string;
  node?: unknown;
  "data-file-link"?: string;
  "data-file-path"?: string;
  "data-file-line"?: number | string;
};

export function FileLinkSpan({
  children,
  className,
  node: _node,
  sessionId,
  "data-file-link": _marker,
  "data-file-path": path,
  "data-file-line": line,
}: FileLinkSpanProps & { sessionId: string }) {
  const token = useMemo(
    () =>
      path
        ? {
            line: line !== undefined ? Number(line) : null,
            rawPath: path,
          }
        : null,
    [path, line],
  );

  const { handleClick, target } = useFileTargetClick(sessionId, token);

  if (!target) {
    return <span className={className}>{children}</span>;
  }

  return (
    <button
      className={cn(
        "wrap-anywhere appearance-none text-left font-medium text-primary underline decoration-dotted",
        className,
      )}
      onClick={handleClick}
      type="button"
    >
      {children}
    </button>
  );
}
