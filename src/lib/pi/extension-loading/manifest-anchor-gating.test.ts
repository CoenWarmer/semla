/**
 * supi-code-intelligence stands up an LSP workspace over the session's cwd from
 * a session_start handler. Anchored on a project that is 519ms cold and 32ms
 * warm; pointed at the workspace root above fifty repositories it was measured
 * at 75s, on every turn, before the model saw the prompt and regardless of
 * which tools were selected — binding happens before tool selection.
 *
 * So a session with no project does not load it. What matters is that the
 * filtered set is still a coherent, verifiable manifest, and that the UI is not
 * left advertising tools the agent does not have.
 */
import { describe, expect, it } from "vitest";

import {
  assertManifestIsCoherent,
  EXTENSION_MANIFEST,
  EXTENSION_TOOLS,
  extensionPathsInLoadOrder,
  extensionToolsForSession,
  manifestForSession,
  resolveExtensionLoadOrder,
  type ExtensionSpec,
} from "./extension-manifest.ts";

const gated = EXTENSION_MANIFEST.filter((spec) => spec.requiresProjectAnchor);

describe("manifestForSession", () => {
  it("gates at least one extension, or none of this does anything", () => {
    expect(gated.map((spec) => spec.id)).toContain("code-intelligence");
  });

  it("loads everything for a session anchored on a project", () => {
    expect(manifestForSession({ projectAnchored: true })).toEqual(
      EXTENSION_MANIFEST,
    );
  });

  it("drops the project-scoped extensions when there is no anchor", () => {
    const specs = manifestForSession({ projectAnchored: false });

    expect(specs.map((spec) => spec.id)).not.toContain("code-intelligence");
    expect(specs.length).toBe(EXTENSION_MANIFEST.length - gated.length);
  });

  /**
   * The point of dropping it: its entry file is what jiti compiles and its
   * session_start handler is what costs the 75 seconds.
   */
  it("stops handing Pi the gated entry file", () => {
    const gatedPaths = gated.flatMap((spec) =>
      spec.source.kind === "path" ? [spec.source.path] : [],
    );
    expect(gatedPaths.length).toBeGreaterThan(0);

    const anchored = extensionPathsInLoadOrder(
      manifestForSession({ projectAnchored: true }),
    );
    const unanchored = extensionPathsInLoadOrder(
      manifestForSession({ projectAnchored: false }),
    );

    for (const path of gatedPaths) {
      expect(anchored).toContain(path);
      expect(unanchored).not.toContain(path);
    }
  });

  // Everything the turn hands to Pi has to survive the filter intact.
  it("still resolves a load order without the gated extensions", () => {
    expect(() =>
      resolveExtensionLoadOrder(manifestForSession({ projectAnchored: false })),
    ).not.toThrow();
  });

  it("is still a coherent manifest without them", () => {
    expect(() =>
      assertManifestIsCoherent(manifestForSession({ projectAnchored: false })),
    ).not.toThrow();
  });
});

describe("extensionToolsForSession", () => {
  it("advertises the full set to an anchored session", () => {
    expect(extensionToolsForSession({ projectAnchored: true })).toEqual(
      EXTENSION_TOOLS,
    );
  });

  /**
   * Offering a tool the agent does not have is the failure this manifest exists
   * to prevent, and it is why optionalTools are kept out of EXTENSION_TOOLS too.
   */
  it("does not advertise the gated tools without an anchor", () => {
    const tools = extensionToolsForSession({ projectAnchored: false });

    for (const tool of gated.flatMap((spec) => spec.providesTools)) {
      expect(tools).not.toContain(tool);
    }
    expect(tools).toContain("workflow");
  });
});

/**
 * A gated extension is simply absent for an unanchored session, so anything
 * that survives the filter must not depend on one — the load order would
 * resolve against a spec that is not there and throw, refusing every
 * unanchored turn rather than merely running without a tool.
 */
describe("coherence of a gated dependency", () => {
  const spec = (over: Partial<ExtensionSpec>): ExtensionSpec => ({
    id: "workflow",
    optionalTools: [],
    providesSlots: [],
    providesTools: [],
    remedy: "",
    requires: [],
    source: { kind: "path", path: "/x.ts" },
    ...over,
  });

  it("rejects an ungated extension that requires a gated one", () => {
    expect(() =>
      assertManifestIsCoherent([
        spec({ id: "code-intelligence", requiresProjectAnchor: true }),
        spec({ id: "wiki", requires: ["code-intelligence"] }),
      ]),
    ).toThrow(/only loaded for a session anchored/);
  });

  it("allows a gated extension to require another gated one", () => {
    expect(() =>
      assertManifestIsCoherent([
        spec({ id: "code-intelligence", requiresProjectAnchor: true }),
        spec({
          id: "wiki",
          requires: ["code-intelligence"],
          requiresProjectAnchor: true,
        }),
      ]),
    ).not.toThrow();
  });

  it("is satisfied by the real manifest", () => {
    expect(() => assertManifestIsCoherent()).not.toThrow();
  });
});
