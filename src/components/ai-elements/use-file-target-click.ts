"use client";

/**
 * Shared resolution/click logic for anything in a message that opens a
 * repo-relative source file in the Review panel: `ClickableFilePathCode`
 * (an inline-code span whose text is path-shaped) and the file-link
 * renderer for markdown links `rehypeFileLinks` rewrites (see
 * `@/lib/markdown/rehype-file-links`). Both resolve a `ParsedFileToken`
 * against the session's attached projects the same way and fire the same
 * `elementTarget.request()` on click; this is that one implementation
 * rather than two copies drifting apart.
 */

import { useCallback, useMemo } from "react";

import { useElementTarget } from "@/components/element-target-provider";
import { useSessionProjects } from "@/hooks/use-session-projects";
import type { ParsedFileToken } from "@/lib/file-path-token";
import { resolveFileToken } from "@/lib/file-path-token";

export function useFileTargetClick(sessionId: string, token: ParsedFileToken | null) {
  const projectsQuery = useSessionProjects(sessionId);
  const projectSlugs = useMemo(
    () => (projectsQuery.data ?? []).map((link) => link.path),
    [projectsQuery.data],
  );

  const target = useMemo(
    () => (token ? resolveFileToken(token, projectSlugs) : null),
    [token, projectSlugs],
  );

  const elementTarget = useElementTarget();

  const handleClick = useCallback(() => {
    if (!target) return;
    elementTarget.request({
      line: target.line ?? 1,
      path: target.path,
      precision: "exact",
      project: target.project,
    });
  }, [elementTarget, target]);

  return { handleClick, target };
}
