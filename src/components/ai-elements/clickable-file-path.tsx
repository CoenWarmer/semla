"use client";

/**
 * Streamdown's `inlineCode` renderer — a slot distinct from `code`, which
 * Streamdown reserves for fenced blocks. Passing this as `inlineCode` (not
 * `code`) in `message.tsx`'s `components` prop is what keeps fenced code
 * blocks on Streamdown's own renderer: Streamdown's dispatch checks
 * `"data-block" in props` itself and only ever routes here for the inline
 * case, so this component never has to make that check or reimplement the
 * fenced-block path (syntax highlighting, copy button, language detection)
 * to avoid regressing it.
 *
 * A span whose text does not resolve to a file the session has an attached
 * project for — no attached project, an ambiguous multi-project session, or
 * text that is not path-shaped at all — renders as plain inline code,
 * matching Streamdown's own default styling exactly, rather than guessing.
 */

import type { ComponentProps, ReactNode } from "react";
import { useMemo } from "react";

import { parseFilePathToken } from "@/lib/file-path-token";
import { cn } from "@/lib/utils";

import { useFileTargetClick } from "./use-file-target-click";

type StreamdownInlineCodeProps = {
  children?: ReactNode;
  className?: string;
  node?: unknown;
} & Omit<ComponentProps<"code">, "children" | "className">;

function childrenToText(children: ReactNode): string | null {
  if (typeof children === "string") return children;
  if (typeof children === "number") return String(children);
  return null;
}

export function ClickableFilePathCode({
  children,
  className,
  node: _node,
  sessionId,
  ...props
}: StreamdownInlineCodeProps & { sessionId: string }) {
  const text = childrenToText(children);
  const token = useMemo(() => (text ? parseFilePathToken(text) : null), [text]);

  const { handleClick, target } = useFileTargetClick(sessionId, token);

  if (!target) {
    return (
      <code
        className={cn("rounded bg-muted px-1.5 py-0.5 font-mono text-sm", className)}
        {...props}
      >
        {children}
      </code>
    );
  }

  return (
    <button
      className={cn(
        "rounded bg-muted px-1.5 py-0.5 font-mono text-sm underline decoration-dotted hover:text-primary",
        className,
      )}
      onClick={handleClick}
      type="button"
    >
      {children}
    </button>
  );
}
