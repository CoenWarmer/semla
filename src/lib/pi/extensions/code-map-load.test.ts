/**
 * Loads the code_map extension the way Pi does — through jiti — and checks it
 * registers its tool.
 *
 * This seam is not covered by tsc. jiti resolves module specifiers differently
 * from both the compiler and Next.js: it cannot follow the "@/" alias, and this
 * extension is the first one to import out of the extensions directory
 * altogether, reaching into ../../code-map and pulling in `typescript` with it.
 * An import that type-checks perfectly can still fail to load here, and the
 * symptom would be a session that silently has no code_map tool.
 *
 * extension-load.smoke.test.ts covers this for the whole manifest, but it needs
 * a configured Pi model and skips without one — which is most CI machines and
 * any checkout without credentials. This runs everywhere.
 */
import { join } from "node:path";

import { describe, expect, it } from "vitest";

type RegisteredTool = {
  description?: string;
  name: string;
  parameters?: unknown;
};

/** Load the extension through jiti and collect what it registers. */
const loadExtension = async () => {
  const { createJiti } = await import("jiti");
  const jiti = createJiti(import.meta.url, { interopDefault: true });

  const factory = (await jiti.import(
    join(process.cwd(), "src/lib/pi/extensions/code-map.ts"),
    { default: true },
  )) as (api: unknown) => void;

  const tools: RegisteredTool[] = [];
  const events: string[] = [];

  factory({
    on: (event: string) => events.push(event),
    registerTool: (tool: RegisteredTool) => tools.push(tool),
  });

  return { events, tools };
};

describe("code_map extension under jiti", () => {
  it("loads without a module-resolution failure", async () => {
    await expect(loadExtension()).resolves.toBeDefined();
  });

  it("registers the tool the manifest promises", async () => {
    const { tools } = await loadExtension();

    expect(tools.map((tool) => tool.name)).toEqual(["code_map"]);
  });

  it("subscribes to session_start, without which cwd is the launch directory", async () => {
    const { events } = await loadExtension();

    expect(events).toContain("session_start");
  });

  it("describes itself to the model", async () => {
    const [tool] = (await loadExtension()).tools;

    expect(tool.description).toContain("call graph");
    expect(tool.parameters).toBeDefined();
  });

  it("runs end to end, returning a map the client can read", async () => {
    const [tool] = (await loadExtension()).tools as Array<
      RegisteredTool & {
        execute: (id: string, params: unknown) => Promise<unknown>;
      }
    >;

    const result = await tool.execute("call-1", {
      file: "src/lib/code-map/call-graph-fixture.ts",
      symbol: "normaliseAll",
    });

    // The same reader session-service uses, so this asserts the contract the
    // panel actually depends on rather than the shape of an internal object.
    const { readCodeMapResult } = await import("../../code-map/tool-result.ts");
    const map = readCodeMapResult(result);

    expect(map).not.toBeNull();
    expect(map?.nodes.map((node) => node.name)).toContain("normalise");
  });

  it("throws for a symbol that is not there, naming the ones that are", async () => {
    const [tool] = (await loadExtension()).tools as Array<
      RegisteredTool & {
        execute: (id: string, params: unknown) => Promise<unknown>;
      }
    >;

    // Thrown, not returned with isError: true — Pi derives a call's error state
    // from how execution ended, so a returned error renders as a successful
    // call in the session record.
    await expect(
      tool.execute("call-2", {
        file: "src/lib/code-map/call-graph-fixture.ts",
        symbol: "nosuchthing",
      }),
    ).rejects.toThrow(/normaliseAll/);
  });
});
