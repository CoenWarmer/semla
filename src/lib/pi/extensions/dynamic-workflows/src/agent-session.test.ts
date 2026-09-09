/**
 * Pins the invariants agent-session.ts's docblocks call load-bearing:
 * subagentExcludedTools always carries the #107 orchestration-tool defaults
 * regardless of what a caller adds (a spread-order regression the docblock
 * says a constant-only test would miss); mergeRelocatedCodingTools lets a
 * relocated tool win over a same-named base tool while leaving every other
 * base tool untouched (the host-toolset bug the docblock describes);
 * buildSubagentTools applies the agentType allow/deny list before adding
 * structured_output, lets systemTools bypass that filter, rejects a
 * non-object schema, and skips rebuilding coding tools when the call's cwd
 * matches the run's own; and createSubagentSessionManager returns an
 * in-memory manager when told not to persist, and otherwise persists into
 * the explicit sessionDir it's given (the project's `.semla-sessions/`, not
 * pi's own default sessions dir). The unwritable-session-dir degrade path
 * is documented as skipped below rather than faked.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildSubagentTools,
  createSubagentSessionManager,
  DEFAULT_EXCLUDED_SUBAGENT_TOOLS,
  mergeRelocatedCodingTools,
  resolvePersistAgentSessions,
  subagentExcludedTools,
} from "./agent-session.ts";
import type { StructuredOutputCapture } from "./structured-output.ts";
import { isWorkflowError, WorkflowErrorCode } from "./errors.ts";

/** A minimal fake ToolDefinition — the fields buildSubagentTools/applyToolPolicy actually read. */
function fakeTool(name: string): ToolDefinition {
  return {
    name,
    label: name,
    description: `fake tool ${name}`,
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text", text: "" }] };
    },
  } as unknown as ToolDefinition;
}

describe("subagentExcludedTools", () => {
  it("always includes the #107 defaults regardless of extra/sessionExclude", () => {
    const result = subagentExcludedTools(["custom_extra"], ["custom_session"]);
    for (const name of DEFAULT_EXCLUDED_SUBAGENT_TOOLS) {
      expect(result).toContain(name);
    }
  });

  it("orders defaults, then sessionExclude, then extra", () => {
    const result = subagentExcludedTools(["extra_tool"], ["session_tool"]);
    expect(result).toEqual([
      ...DEFAULT_EXCLUDED_SUBAGENT_TOOLS,
      "session_tool",
      "extra_tool",
    ]);
  });

  it("leaves duplicates alone, relying on the SDK to dedupe", () => {
    const result = subagentExcludedTools(["workflow"], undefined);
    expect(result.filter((name) => name === "workflow")).toHaveLength(2);
  });

  it("carries the defaults even when no extras are given at all", () => {
    expect(subagentExcludedTools()).toEqual(DEFAULT_EXCLUDED_SUBAGENT_TOOLS);
  });
});

describe("mergeRelocatedCodingTools", () => {
  it("lets a relocated tool win over a same-named base tool", () => {
    const baseRead = fakeTool("read");
    const relocatedRead = fakeTool("read");
    const merged = mergeRelocatedCodingTools([baseRead], [relocatedRead]);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toBe(relocatedRead);
  });

  it("puts relocated tools first, ahead of surviving base tools", () => {
    const base = [fakeTool("read"), fakeTool("wiki_search")];
    const relocated = [fakeTool("read")];
    const merged = mergeRelocatedCodingTools(base, relocated);

    expect(merged.map((tool) => tool.name)).toEqual(["read", "wiki_search"]);
  });

  it("keeps a base tool with no relocated counterpart (host-toolset survival)", () => {
    const wikiTool = fakeTool("wiki_search");
    const merged = mergeRelocatedCodingTools(
      [fakeTool("read"), wikiTool],
      [fakeTool("read"), fakeTool("write")],
    );

    expect(merged).toContain(wikiTool);
    expect(merged.map((tool) => tool.name)).toEqual(["read", "write", "wiki_search"]);
  });
});

describe("buildSubagentTools", () => {
  function capture(): StructuredOutputCapture<unknown> {
    return { value: undefined, called: false };
  }

  it("applies the agentType allowlist before adding structured_output, so a restrictive allowlist never strips it", () => {
    const baseTools = [fakeTool("read"), fakeTool("bash")];
    const tools = buildSubagentTools(
      { toolNames: ["read"], schema: Type.Object({ ok: Type.Boolean() }) },
      baseTools,
      "/cwd",
      "/cwd",
      capture(),
    );

    const names = tools.map((t) => t.name);
    expect(names).toContain("read");
    expect(names).not.toContain("bash");
    expect(names).toContain("structured_output");
  });

  it("lets systemTools bypass the allow/deny filter", () => {
    const baseTools = [fakeTool("read")];
    const systemTool = fakeTool("shared_store");
    const tools = buildSubagentTools(
      { toolNames: ["read"], systemTools: [systemTool] },
      baseTools,
      "/cwd",
      "/cwd",
      capture(),
    );

    expect(tools.map((t) => t.name)).toContain("shared_store");
  });

  it("throws SCRIPT_VALIDATION_ERROR when opts.schema's top-level type isn't object", () => {
    const baseTools = [fakeTool("read")];
    try {
      buildSubagentTools(
        { schema: Type.Array(Type.String()) },
        baseTools,
        "/cwd",
        "/cwd",
        capture(),
      );
      expect.unreachable();
    } catch (error) {
      expect(isWorkflowError(error)).toBe(true);
      if (!isWorkflowError(error)) throw error;
      expect(error.code).toBe(WorkflowErrorCode.SCRIPT_VALIDATION_ERROR);
    }
  });

  it("does not rebuild base tools when runCwd equals agentCwd", () => {
    const baseTools = [fakeTool("read"), fakeTool("bash")];
    const tools = buildSubagentTools({}, baseTools, "/same/cwd", "/same/cwd", capture());

    // Same cwd: baseTools flow through untouched (no createCodingTools rebuild),
    // so every returned tool is reference-identical to what was passed in.
    expect(tools).toHaveLength(baseTools.length);
    for (const tool of baseTools) {
      expect(tools).toContain(tool);
    }
  });
});

describe("resolvePersistAgentSessions", () => {
  it("defaults to true when no settings/options value is given", () => {
    expect(resolvePersistAgentSessions(undefined)).toBe(true);
  });

  it("honors an explicit false, overriding the default", () => {
    expect(resolvePersistAgentSessions(false)).toBe(false);
  });

  it("honors an explicit true", () => {
    expect(resolvePersistAgentSessions(true)).toBe(true);
  });
});

describe("createSubagentSessionManager", () => {
  it("returns an in-memory manager when persistAgentSessions is false", () => {
    const manager = createSubagentSessionManager("/some/cwd", false);
    expect(manager.isPersisted()).toBe(false);
  });

  describe("with an explicit sessionDir", () => {
    let tempCwd: string;
    let tempSessionDir: string;

    afterEach(() => {
      rmSync(tempCwd, { recursive: true, force: true });
      rmSync(tempSessionDir, { recursive: true, force: true });
    });

    it("persists into the given sessionDir rather than pi's own default", () => {
      tempCwd = mkdtempSync(join(tmpdir(), "agent-session-cwd-"));
      tempSessionDir = mkdtempSync(join(tmpdir(), "agent-session-dir-"));

      const manager = createSubagentSessionManager(tempCwd, true, tempSessionDir);

      expect(manager.isPersisted()).toBe(true);
      expect(manager.getSessionDir()).toBe(tempSessionDir);
    });
  });

  // The unwritable-session-dir degrade path (createSubagentSessionManager's
  // catch branch) is intentionally not exercised here: reaching it
  // deterministically would mean either chmod'ing a directory this test
  // doesn't own (unreliable when the test runner is root, which ignores
  // permission bits) or mocking SessionManager.create/assertSessionDirWritable
  // — both brittle against a function whose contract is "never throw", not
  // against its internals. Skipped rather than written unreliable.

  describe("default sessionDir (no explicit third argument)", () => {
    let tempWorkspace: string;

    afterEach(() => {
      vi.unstubAllEnvs();
      vi.resetModules();
      rmSync(tempWorkspace, { recursive: true, force: true });
    });

    it("resolves to the project's .semla-sessions, matching the main session's PI_SESSION_DIR", async () => {
      // PI_SESSION_DIR is computed once at module load from
      // process.env.PI_SESSION_DIR (see runtime-config.ts). Stub the env var
      // to a temp directory and reload both modules so the constant picks it
      // up, rather than writing into this repository's real .semla-sessions/.
      tempWorkspace = mkdtempSync(join(tmpdir(), "agent-session-workspace-"));
      const expectedSessionDir = join(tempWorkspace, ".semla-sessions");
      vi.stubEnv("PI_SESSION_DIR", expectedSessionDir);
      vi.resetModules();

      const { PI_SESSION_DIR: reloadedSessionDir } = await import(
        "../../../runtime-config.ts"
      );
      const { createSubagentSessionManager: reloadedCreate } = await import(
        "./agent-session.ts"
      );

      expect(reloadedSessionDir).toBe(expectedSessionDir);

      const manager = reloadedCreate(tempWorkspace, true);

      expect(manager.getSessionDir()).toBe(expectedSessionDir);
    });
  });
});
