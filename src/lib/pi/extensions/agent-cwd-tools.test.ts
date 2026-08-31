/**
 * A capture agent that named its own cwd — to run git inside the repository it
 * was orienting — arrived with only read, bash, edit, write and the store
 * tools, while its siblings had the wiki tools and captured normally. Rebuilding
 * the coding tools for the new directory had been replacing the whole set, so
 * everything the host toolset contributed went with it.
 */
import { describe, expect, it } from "vitest";

import { mergeRelocatedCodingTools } from "./dynamic-workflows/src/agent.ts";

const tool = (name: string, cwd?: string) =>
  ({ name, cwd }) as unknown as Parameters<typeof mergeRelocatedCodingTools>[0][number];

describe("mergeRelocatedCodingTools", () => {
  const base = [
    tool("bash", "/workspace"),
    tool("read", "/workspace"),
    tool("wiki_capture_source"),
    tool("wiki_search"),
  ];
  const relocated = [tool("bash", "/repo"), tool("read", "/repo")];

  it("keeps the tools the host contributed", () => {
    const merged = mergeRelocatedCodingTools(base, relocated);

    expect(merged.map((t) => t.name)).toContain("wiki_capture_source");
    expect(merged.map((t) => t.name)).toContain("wiki_search");
  });

  // The reason the swap exists: coding tools capture cwd at construction.
  it("takes the coding tools bound to the new directory", () => {
    const merged = mergeRelocatedCodingTools(base, relocated);

    const bash = merged.find((t) => t.name === "bash") as unknown as { cwd: string };
    expect(bash.cwd).toBe("/repo");
    expect(merged.filter((t) => t.name === "bash")).toHaveLength(1);
  });

  it("does not duplicate a tool that exists in both", () => {
    const merged = mergeRelocatedCodingTools(base, relocated);

    expect(merged.map((t) => t.name)).toEqual([
      "bash",
      "read",
      "wiki_capture_source",
      "wiki_search",
    ]);
  });

  it("is just the relocated set when the host contributed nothing", () => {
    expect(mergeRelocatedCodingTools(relocated, relocated).map((t) => t.name)).toEqual([
      "bash",
      "read",
    ]);
  });
});
