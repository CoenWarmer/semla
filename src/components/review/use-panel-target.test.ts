// @vitest-environment jsdom
/**
 * Composition test for `usePanelTarget`.
 *
 * Everything the four sources' *rules* decide is already proven, in
 * isolation, by review-panel-request.test.ts, review-anchor-reveal.test.ts
 * and review-artifact-commit.test.ts. What was untested before this hook
 * existed is their *composition* — the precedence order, the `overNonce`
 * bookkeeping, and the follow-mode derivation all wired together — which
 * used to be exercised only by rendering the whole panel. This renders the
 * hook alone, with `@testing-library/react`'s `renderHook`, which is why
 * this file (and only this file — see vitest.config.mts) opts into a DOM.
 *
 * Data fetching is stubbed at `fetch`, not mocked away: `useReview`,
 * `useReviewHunks`, and `useUserSettings`/`useUpdateFollowMode` are real
 * React Query hooks reading real (stubbed) network responses, so this pins
 * the hook's actual data-dependency shape rather than a fake of it.
 */
import { createElement, type ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionReview } from "@/lib/review/review-types";
import { sessionLiveAccessesKey } from "@/lib/session/session-live-state";
import { MAIN_AGENT, type FileAccess } from "@/lib/pi/file-access/access-types";

import type { PanelTarget } from "./review-panel-request";
import { usePanelTarget } from "./use-panel-target.ts";

const review = (): SessionReview => ({
  changedThisTurn: false,
  fingerprint: "fp",
  projects: [
    {
      changedFiles: [
        {
          indexCode: " ",
          oldPath: null,
          path: "src/a.ts",
          staged: false,
          status: "modified",
          unstaged: true,
          worktreeCode: "M",
        },
        {
          indexCode: " ",
          oldPath: null,
          path: "src/b.ts",
          staged: false,
          status: "modified",
          unstaged: true,
          worktreeCode: "M",
        },
      ],
      headSha: "head",
      name: "semla",
      omitted: 0,
      otherActiveSessions: 0,
      path: "semla",
      startSha: null,
      turnCommits: [],
    },
  ],
  reviewed: false,
});

const target = (over: Partial<PanelTarget> = {}): PanelTarget => ({
  nonce: 1,
  path: "src/a.ts",
  project: "semla",
  ...over,
});

/**
 * Answers every route the hook's dependencies read, by URL prefix.
 *
 * `/user-settings` echoes the PUT body's `followMode` back as the settled
 * settings, the way the real route does — a fixed response would overwrite
 * `useUpdateFollowMode`'s optimistic `onMutate` write the instant the
 * mutation resolved, undoing the very toggle a test just made.
 */
function stubFetch() {
  let followMode = false;

  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;

    if (url.includes("/review/hunks")) {
      return new Response(JSON.stringify(null), { status: 404 });
    }
    if (url.includes("/review")) {
      return new Response(JSON.stringify(review()));
    }
    if (url.includes("/user-settings")) {
      if (init?.method === "PUT") {
        const body = JSON.parse((init.body as string) ?? "{}") as {
          followMode?: boolean;
        };
        if (typeof body.followMode === "boolean") followMode = body.followMode;
      }
      return new Response(JSON.stringify({ settings: { follow_mode: followMode } }));
    }
    return new Response(JSON.stringify({}));
  });
}

function renderPanelTarget(target: PanelTarget | null) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);

  const utils = renderHook(
    ({ target }: { target: PanelTarget | null }) =>
      usePanelTarget("session-1", target),
    { initialProps: { target }, wrapper },
  );

  return { queryClient, ...utils };
}

describe("usePanelTarget", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", stubFetch());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("opens on the anchor project's first changed file with no target", async () => {
    const { result } = renderPanelTarget(null);

    await waitFor(() =>
      expect(result.current.selection).toEqual({ path: "src/a.ts", project: "semla" }),
    );
  });

  it("opens on the target's file, folding its hunks open", async () => {
    const { result } = renderPanelTarget(target({ line: 12, path: "src/b.ts" }));

    await waitFor(() =>
      expect(result.current.selection).toEqual({ path: "src/b.ts", project: "semla" }),
    );
    expect(result.current.expanded).toEqual({ path: "src/b.ts", project: "semla" });
    expect(result.current.reveal).toEqual({ line: 12, nonce: 1 });
  });

  it("lets the panel's own navigation override the target until a newer one arrives", async () => {
    const { rerender, result } = renderPanelTarget(target({ path: "src/a.ts" }));
    await waitFor(() => expect(result.current.selection?.path).toBe("src/a.ts"));

    act(() => result.current.selectFile({ path: "src/b.ts", project: "semla" }));
    expect(result.current.selection).toEqual({ path: "src/b.ts", project: "semla" });

    // The same target, re-rendered, does not resurrect — its nonce is
    // unchanged, so the panel's own request still applies.
    rerender({ target: target({ path: "src/a.ts" }) });
    expect(result.current.selection).toEqual({ path: "src/b.ts", project: "semla" });

    // A genuinely new target (a new nonce) overrides the panel's own history.
    rerender({ target: target({ nonce: 2, path: "src/a.ts" }) });
    await waitFor(() =>
      expect(result.current.selection).toEqual({ path: "src/a.ts", project: "semla" }),
    );
  });

  it("opens a comment's own file and reveals its first line, in one revision", async () => {
    const { result } = renderPanelTarget(null);
    await waitFor(() => expect(result.current.selection?.path).toBe("src/a.ts"));

    act(() => {
      result.current.openComment({
        body: { kind: "text", text: "why" },
        createdAt: "2026-01-01T00:00:00Z",
        endLine: 42,
        filePath: "src/b.ts",
        id: "c1",
        projectPath: "semla",
        startLine: 40,
      });
    });

    // Both halves land together — the file *and* the line. Two separate
    // revisions would race and only the last one's field would survive,
    // which is the whole reason openComment exists rather than the caller
    // doing selectFile + revealLine.
    await waitFor(() =>
      expect(result.current.selection).toEqual({ path: "src/b.ts", project: "semla" }),
    );
    expect(result.current.reveal?.line).toBe(40);
  });

  it("re-reveals a comment in the file already open", async () => {
    const { result } = renderPanelTarget(null);
    await waitFor(() => expect(result.current.selection?.path).toBe("src/a.ts"));

    const comment = (startLine: number) => ({
      body: { kind: "text", text: "why" } as const,
      createdAt: "2026-01-01T00:00:00Z",
      endLine: startLine,
      filePath: "src/a.ts",
      id: `c-${startLine}`,
      projectPath: "semla",
      startLine,
    });

    act(() => {
      result.current.openComment(comment(10));
    });
    await waitFor(() => expect(result.current.reveal?.line).toBe(10));
    const first = result.current.reveal!.nonce;

    act(() => {
      result.current.openComment(comment(20));
    });

    // Same file throughout, so the nonce is what makes the second step a
    // real request rather than an unchanged prop.
    await waitFor(() => expect(result.current.reveal?.line).toBe(20));
    expect(result.current.reveal!.nonce).toBeGreaterThan(first);
    expect(result.current.selection).toEqual({ path: "src/a.ts", project: "semla" });
  });

  it("reports a workspace path outside every project as a refusal, not a crash", async () => {
    const { result } = renderPanelTarget(null);
    await waitFor(() => expect(result.current.selection).not.toBeNull());

    let failure: { error: string } | null | undefined;
    act(() => {
      failure = result.current.openWorkspacePath("other-repo/src/c.ts", 4);
    });

    expect(failure).not.toBeNull();
    expect(failure?.error).toContain("is not inside a project this session is linked to");
  });

  it("follows the agent's live writes once follow mode is on", async () => {
    const { queryClient, rerender, result } = renderPanelTarget(null);
    await waitFor(() => expect(result.current.selection?.path).toBe("src/a.ts"));

    act(() => result.current.changeFollowing(true));
    await waitFor(() => expect(result.current.following).toBe(true));

    const write: FileAccess = {
      agent: MAIN_AGENT,
      at: "2026-01-01T00:00:00.000Z",
      callId: "call-1",
      confidence: "exact",
      id: "write-1",
      kind: "write",
      missing: false,
      path: "src/b.ts",
      project: "semla",
      ranges: [{ end: 10, start: 5 }],
      tool: "edit",
      turnId: "turn-1",
    };
    queryClient.setQueryData(sessionLiveAccessesKey("session-1"), [write]);
    rerender({ target: null });

    await waitFor(() =>
      expect(result.current.selection).toEqual({ path: "src/b.ts", project: "semla" }),
    );
  });

  it("lets a fresh external target beat follow, so a click is not discarded", async () => {
    const { queryClient, rerender, result } = renderPanelTarget(null);
    await waitFor(() => expect(result.current.selection?.path).toBe("src/a.ts"));

    act(() => result.current.changeFollowing(true));
    await waitFor(() => expect(result.current.following).toBe(true));

    const write: FileAccess = {
      agent: MAIN_AGENT,
      at: "2026-01-01T00:00:00.000Z",
      callId: "call-1",
      confidence: "exact",
      id: "write-1",
      kind: "write",
      missing: false,
      path: "src/agent-touched.ts",
      project: "semla",
      ranges: [],
      tool: "edit",
      turnId: "turn-1",
    };
    queryClient.setQueryData(sessionLiveAccessesKey("session-1"), [write]);
    rerender({ target: null });
    await waitFor(() =>
      expect(result.current.selection?.path).toBe("src/agent-touched.ts"),
    );

    // A click while following is on must open the clicked file, not lose it
    // to the agent's latest write — the regression `baseRequestFor` exists
    // to prevent (see review-panel-request.ts).
    rerender({ target: target({ nonce: 9, path: "src/clicked.ts" }) });
    await waitFor(() => expect(result.current.selection?.path).toBe("src/clicked.ts"));
  });
});
