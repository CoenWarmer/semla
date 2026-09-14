/**
 * Handler-level tests for the item-3 edit/write replacements, following the
 * fake-ExtensionAPI convention in read-router.test.ts.
 *
 * Pi's own edit/write execution (diff generation, patch, actual file I/O) is
 * exercised against the real filesystem via `createEditToolDefinition`/
 * `createWriteToolDefinition` — these tests are about the placement check and
 * the enforcement feedback wrapped around that delegate, not about
 * reimplementing edit/write's own test suite.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import { placementFilePath } from "./placement-rules";

const placementToolsExtension = (await import("./placement-tools")).default;

type Handler = {
  name: string;
  execute: (
    toolCallId: string,
    params: unknown,
    signal: undefined,
    onUpdate: undefined,
    ctx: ExtensionContext,
  ) => Promise<{ content: Array<{ type: string; text: string }>; details: unknown }>;
};

function makePi() {
  const tools = new Map<string, Handler>();
  const pi = {
    on: vi.fn(),
    registerTool: vi.fn((tool: Handler) => {
      tools.set(tool.name, tool);
    }),
  } as unknown as Parameters<typeof placementToolsExtension>[0];

  return {
    call: (name: "edit" | "write", params: unknown, ctx: ExtensionContext) => {
      const tool = tools.get(name);
      if (!tool) throw new Error(`tool ${name} was not registered`);
      return tool.execute("call-1", params, undefined, undefined, ctx);
    },
    pi,
  };
}

function makeCtx(cwd: string, sessionId = "session-1"): ExtensionContext {
  return {
    cwd,
    sessionManager: {
      getSessionDir: () => cwd,
      getSessionId: () => sessionId,
    },
  } as unknown as ExtensionContext;
}

describe("placement-tools: write", () => {
  let dir: string;

  afterEach(() => {
    if (dir && existsSync(dir)) rmSync(dir, { force: true, recursive: true });
  });

  it("accepts a target_module that matches a PLACEMENT.md rule and writes the file", async () => {
    dir = mkdtempSync(join(tmpdir(), "placement-tools-test-"));
    writeFileSync(placementFilePath(dir), "new REST route -> server/routes/\n");

    const { call, pi } = makePi();
    placementToolsExtension(pi);

    await call(
      "write",
      {
        content: "export const x = 1;",
        path: join(dir, "server/routes/users.ts"),
        rationale: "new user-facing endpoint",
        target_module: "server/routes/",
      },
      makeCtx(dir),
    );

    expect(readFileSync(join(dir, "server/routes/users.ts"), "utf-8")).toBe("export const x = 1;");
  });

  it("rejects a target_module that contradicts PLACEMENT.md, quoting the matching rule, and does not write", async () => {
    dir = mkdtempSync(join(tmpdir(), "placement-tools-test-"));
    writeFileSync(placementFilePath(dir), "new REST route -> server/routes/\n");

    const { call, pi } = makePi();
    placementToolsExtension(pi);

    const result = await call(
      "write",
      {
        content: "export const x = 1;",
        path: join(dir, "random/place/users.ts"),
        rationale: "put it here for no reason",
        target_module: "random/place",
      },
      makeCtx(dir),
    );

    expect(result.content[0].text).toContain("PLACEMENT.md");
    expect(existsSync(join(dir, "random/place/users.ts"))).toBe(false);
  });

  it("allows any target_module when the target repo has no PLACEMENT.md", async () => {
    dir = mkdtempSync(join(tmpdir(), "placement-tools-test-"));

    const { call, pi } = makePi();
    placementToolsExtension(pi);

    await call(
      "write",
      {
        content: "export const x = 1;",
        path: join(dir, "anywhere.ts"),
        rationale: "no rules file, so nothing to contradict",
        target_module: "anywhere",
      },
      makeCtx(dir),
    );

    expect(existsSync(join(dir, "anywhere.ts"))).toBe(true);
  });
});

describe("placement-tools: edit", () => {
  let dir: string;

  afterEach(() => {
    if (dir && existsSync(dir)) rmSync(dir, { force: true, recursive: true });
  });

  it("delegates to Pi's own edit behaviour for an accepted call", async () => {
    dir = mkdtempSync(join(tmpdir(), "placement-tools-test-"));
    const filePath = join(dir, "existing.ts");
    writeFileSync(filePath, "const a = 1;\n");

    const { call, pi } = makePi();
    placementToolsExtension(pi);

    await call(
      "edit",
      {
        edits: [{ newText: "const a = 2;", oldText: "const a = 1;" }],
        path: filePath,
        rationale: "bump the constant",
        target_module: "src/lib",
      },
      makeCtx(dir),
    );

    expect(readFileSync(filePath, "utf-8")).toBe("const a = 2;\n");
  });
});
