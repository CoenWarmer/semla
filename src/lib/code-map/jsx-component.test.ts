/**
 * Against real Semla source rather than a fixture: the whole point of this
 * module is resolving a name the way a JSX tag in an *actual* page uses it,
 * and a synthetic fixture would not exercise the property-access tag name
 * case or a real tsconfig's module resolution.
 *
 * `session-topbar.tsx:218` renders `<InspectorPanel .../>`, and
 * `inspector-panel.tsx:86` is where `InspectorPanel` is declared. Both line
 * numbers are asserted, so an edit to either file that moves them is meant to
 * break this test — the same contract call-graph-fixture.ts documents for its
 * own line numbers.
 */
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveJsxComponent, resolveJsxComponentChain } from "./jsx-component.ts";

const TOPBAR = join(process.cwd(), "src/components/session-topbar.tsx");

describe("resolveJsxComponent", () => {
  it("resolves a component name to its declaration", () => {
    expect(
      resolveJsxComponent({ componentName: "InspectorPanel", file: TOPBAR }),
    ).toMatchObject({
      file: "src/components/inspector-panel.tsx",
      line: 86,
    });
  });

  it("returns null for a name not used as a JSX tag in that file", () => {
    expect(
      resolveJsxComponent({ componentName: "NoSuchComponent", file: TOPBAR }),
    ).toBeNull();
  });

  it("returns null for a file outside the TypeScript project", () => {
    expect(
      resolveJsxComponent({
        componentName: "InspectorPanel",
        file: join(process.cwd(), "README.md"),
      }),
    ).toBeNull();
  });

  it("returns null for a file that does not exist", () => {
    expect(
      resolveJsxComponent({
        componentName: "InspectorPanel",
        file: join(process.cwd(), "src/components/does-not-exist.tsx"),
      }),
    ).toBeNull();
  });
});

describe("resolveJsxComponentChain", () => {
  const PAGE = join(process.cwd(), "src/app/sessions/[id]/page.tsx");

  it("hops inward through a real chain to the innermost component", () => {
    // page.tsx renders <ClientSessionComponent>, which renders
    // <SessionTopbar>, which renders <InspectorPanel> at line 86 of its own
    // file — three real hops in this repository, the exact shape the picker
    // hits when a fiber's own debug stack is throttled all the way down to
    // the page boundary.
    expect(
      resolveJsxComponentChain({
        chain: ["ClientSessionComponent", "SessionTopbar", "InspectorPanel"],
        file: PAGE,
      }),
    ).toMatchObject({
      file: "src/components/inspector-panel.tsx",
      line: 86,
    });
  });

  it("returns the furthest point reached when the chain runs out early", () => {
    expect(
      resolveJsxComponentChain({
        chain: ["ClientSessionComponent", "SessionTopbar", "NoSuchComponent"],
        file: PAGE,
      }),
    ).toMatchObject({
      file: "src/components/session-topbar.tsx",
    });
  });

  it("returns null when even the first hop fails", () => {
    expect(
      resolveJsxComponentChain({
        chain: ["NoSuchComponent"],
        file: PAGE,
      }),
    ).toBeNull();
  });
});
