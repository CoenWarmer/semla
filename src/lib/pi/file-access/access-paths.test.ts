import { describe, expect, it } from "vitest";

import { resolveAccessPath, toFileAccess, type AccessWorkspace } from "./access-paths.ts";
import type { RawAccess } from "./access-types.ts";

const workspace: AccessWorkspace = {
  agentCwd: "/ws/semla",
  projects: ["semla", "semla-wiki"],
  workspaceRoot: "/ws",
};

describe("resolveAccessPath", () => {
  it("resolves a path relative to where the agent was running", () => {
    // The agent cwd is not the workspace root: a session anchored on `semla`
    // runs there, so `src/a.ts` means `semla/src/a.ts`.
    expect(resolveAccessPath("src/a.ts", workspace)).toEqual({
      absolute: "/ws/semla/src/a.ts",
      path: "src/a.ts",
      project: "semla",
    });
  });

  it("resolves an absolute path without consulting the cwd", () => {
    expect(resolveAccessPath("/ws/semla-wiki/notes.md", workspace)).toEqual({
      absolute: "/ws/semla-wiki/notes.md",
      path: "notes.md",
      project: "semla-wiki",
    });
  });

  it("does not claim a sibling whose name starts the same way", () => {
    // `semla` prefixes `semla-wiki`. Getting this wrong opens the right path in
    // the wrong repository, which reads as a missing file.
    const unlinked: AccessWorkspace = { ...workspace, projects: ["semla"] };
    expect(resolveAccessPath("/ws/semla-wiki/notes.md", unlinked)).toEqual({
      absolute: "/ws/semla-wiki/notes.md",
      path: "semla-wiki/notes.md",
      project: null,
    });
  });

  it("keeps a workspace-relative path for a project that is not linked", () => {
    const result = resolveAccessPath("/ws/kibana/src/x.ts", workspace);
    expect(result).toEqual({
      absolute: "/ws/kibana/src/x.ts",
      path: "kibana/src/x.ts",
      project: null,
    });
  });

  it("keeps an absolute path for somewhere outside the workspace", () => {
    // Two different reasons for `project: null`, and the path form is what
    // tells them apart for the label the scrubber shows.
    expect(resolveAccessPath("/etc/hosts.md", workspace)).toEqual({
      absolute: "/etc/hosts.md",
      path: "/etc/hosts.md",
      project: null,
    });
  });

  it("normalises a path that climbs back into the workspace", () => {
    expect(resolveAccessPath("../semla-wiki/notes.md", workspace).project).toBe(
      "semla-wiki",
    );
  });
});

describe("toFileAccess", () => {
  const raw: RawAccess = {
    confidence: "inferred",
    kind: "read",
    ranges: [{ end: 40, start: 1 }],
    rawPath: "src/a.ts",
    tool: "bash",
  };

  const origin = {
    agent: { id: "main", label: "Main" },
    at: "2026-09-09T19:35:16.000Z",
    callId: "toolu_1",
    id: "toolu_1",
    turnId: "entry-1",
  };

  it("marks a path that is not on disk as missing", () => {
    // 14% of parsed paths are files that existed when the session ran and have
    // since moved. They stay in the timeline — that is worth knowing — but the
    // arrows must not open a 404.
    const access = toFileAccess(raw, origin, workspace, () => false);
    expect(access.missing).toBe(true);
    expect(access.confidence).toBe("inferred");
  });

  it("carries the resolved project and range through", () => {
    const access = toFileAccess(raw, origin, workspace, () => true);
    expect(access).toEqual({
      agent: origin.agent,
      at: origin.at,
      callId: "toolu_1",
      confidence: "inferred",
      id: "toolu_1",
      kind: "read",
      missing: false,
      path: "src/a.ts",
      project: "semla",
      ranges: [{ end: 40, start: 1 }],
      tool: "bash",
      turnId: "entry-1",
    });
  });

  it("omits the symbol key entirely when there is none", () => {
    expect("symbol" in toFileAccess(raw, origin, workspace, () => true)).toBe(
      false,
    );
  });
});
