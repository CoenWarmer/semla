import { describe, expect, it } from "vitest";

import { writtenPath } from "@/lib/pi/session/session-project-attach";

import { accessesFromToolCall } from "./access-from-tool-call.ts";

const call = (
  name: string,
  args: unknown,
  details?: unknown,
): Parameters<typeof accessesFromToolCall>[0] => ({
  arguments: args,
  id: "toolu_1",
  name,
  ...(details === undefined ? {} : { details }),
});

describe("read", () => {
  it("treats a bare read as the whole file", () => {
    // No range rather than `1..null`, so the scrubber can say "whole file"
    // instead of "from the top", which are different things to have read.
    expect(accessesFromToolCall(call("read", { path: "src/a.ts" }))).toEqual([
      {
        confidence: "exact",
        kind: "read",
        ranges: [],
        rawPath: "src/a.ts",
        tool: "read",
      },
    ]);
  });

  it("turns offset and limit into an inclusive range", () => {
    const [access] = accessesFromToolCall(
      call("read", { limit: 55, offset: 95, path: "src/a.ts" }),
    );
    expect(access?.ranges).toEqual([{ end: 149, start: 95 }]);
  });

  it("runs an offset without a limit to the end of the file", () => {
    const [access] = accessesFromToolCall(
      call("read", { offset: 300, path: "src/a.ts" }),
    );
    expect(access?.ranges).toEqual([{ end: null, start: 300 }]);
  });

  it("starts a limit without an offset at line one", () => {
    const [access] = accessesFromToolCall(
      call("read", { limit: 40, path: "src/a.ts" }),
    );
    expect(access?.ranges).toEqual([{ end: 40, start: 1 }]);
  });

  it("yields nothing without a path", () => {
    expect(accessesFromToolCall(call("read", { offset: 3 }))).toEqual([]);
  });
});

describe("edit and write", () => {
  it("anchors an edit on the first changed line", () => {
    const [access] = accessesFromToolCall(
      call("edit", { path: "src/a.ts" }, { firstChangedLine: 42 }),
    );
    expect(access).toMatchObject({
      kind: "write",
      ranges: [{ end: 42, start: 42 }],
      tool: "edit",
    });
  });

  it("survives an edit result whose details are empty", () => {
    // Observed once in the sampled corpus. The file still opens; the editor's
    // own hunk auto-scroll usually lands correctly anyway.
    const [access] = accessesFromToolCall(call("edit", { path: "src/a.ts" }, {}));
    expect(access?.ranges).toEqual([]);
  });

  it("treats a write as the whole file", () => {
    const [access] = accessesFromToolCall(
      call("write", { content: "x", path: "src/a.ts" }),
    );
    expect(access).toMatchObject({ kind: "write", ranges: [], tool: "write" });
  });

  it("agrees with writtenPath about which tools mutate", () => {
    // Two definitions of "this tool changed a file" would drift, and the one in
    // session-project-attach.ts decides whether a project gets linked at all.
    for (const name of ["read", "edit", "write", "bash", "code_resolve"]) {
      const mutatesHere = accessesFromToolCall(
        call(name, { command: "ls", path: "src/a.ts" }),
      ).some((access) => access.kind === "write");

      expect([name, mutatesHere]).toEqual([
        name,
        writtenPath(name, { path: "src/a.ts" }) !== null,
      ]);
    }
  });
});

describe("code intelligence", () => {
  const resolved = {
    data: {
      targets: [
        {
          displayLine: 75,
          file: "src/lib/paths/file-path-token.ts",
          kind: "Function",
          name: "parseFilePathToken",
        },
      ],
    },
  };

  it("reads a symbol's definition line off the resolved target", () => {
    const [access] = accessesFromToolCall(
      call("code_resolve", { target: {} }, resolved),
    );
    expect(access).toEqual({
      confidence: "exact",
      kind: "read",
      ranges: [{ end: 75, start: 75 }],
      rawPath: "src/lib/paths/file-path-token.ts",
      symbol: { kind: "Function", line: 75, name: "parseFilePathToken" },
      tool: "code_resolve",
    });
  });

  it("yields nothing for a code tool that answers in another shape", () => {
    // `code_find` returns `evidenceLists`, not `targets`. Nothing is better
    // than a guess at which of its candidates the agent actually looked at.
    expect(
      accessesFromToolCall(
        call("code_find", {}, { data: { evidenceLists: [], candidateCount: 3 } }),
      ),
    ).toEqual([]);
  });
});

describe("tools that touch no project file", () => {
  it("ignores mcp, whose matches are tools rather than files", () => {
    expect(
      accessesFromToolCall(
        call("mcp", { mode: "search" }, { matches: [{ tool: "x", server: "y" }] }),
      ),
    ).toEqual([]);
  });

  it("ignores the wiki tools, which write to the vault", () => {
    expect(accessesFromToolCall(call("wiki_ensure_page", { slug: "x" }))).toEqual(
      [],
    );
  });
});
