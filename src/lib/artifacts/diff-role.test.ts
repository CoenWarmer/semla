import { describe, expect, it } from "vitest";

import {
  resolveDiffRole,
  roleFromDeclaration,
  roleFromPath,
} from "@/lib/artifacts/diff-role";

describe("roleFromDeclaration", () => {
  it("accepts the declared role and marks it as a fact", () => {
    expect(roleFromDeclaration("plan")).toEqual({ name: "plan", source: "declared" });
  });

  it("normalizes case and surrounding whitespace", () => {
    expect(roleFromDeclaration("  Plan ")).toEqual({ name: "plan", source: "declared" });
  });

  it("returns null for an unknown role rather than throwing", () => {
    // The argument is model-supplied: a typo must cost the role, not the
    // artifact that would otherwise have been captured.
    expect(roleFromDeclaration("planning")).toBeNull();
    expect(roleFromDeclaration("")).toBeNull();
  });

  it("returns null for a non-string", () => {
    expect(roleFromDeclaration(undefined)).toBeNull();
    expect(roleFromDeclaration(null)).toBeNull();
    expect(roleFromDeclaration(7)).toBeNull();
  });
});

describe("roleFromPath", () => {
  it("infers a plan from the docs/plans prefix and marks it as a guess", () => {
    expect(roleFromPath("docs/plans/commit-scoped-review.md")).toEqual({
      name: "plan",
      source: "inferred",
    });
  });

  it("normalizes a leading ./ and backslashes", () => {
    expect(roleFromPath("./docs/plans/a.md")?.name).toBe("plan");
    expect(roleFromPath("docs\\plans\\a.md")?.name).toBe("plan");
  });

  it("does not infer from a path that merely contains the prefix", () => {
    // Anchored at the project root, so a nested lookalike is not a plan.
    expect(roleFromPath("src/lib/docs/plans/helper.ts")).toBeNull();
  });

  it("infers nothing for ordinary source or a null path", () => {
    expect(roleFromPath("src/lib/artifacts/diff-role.ts")).toBeNull();
    expect(roleFromPath("docs/design/whatever.md")).toBeNull();
    expect(roleFromPath(null)).toBeNull();
  });
});

describe("resolveDiffRole", () => {
  it("prefers the declaration over the path", () => {
    // The agent knows something the path cannot express.
    expect(
      resolveDiffRole({ declared: "plan", writtenPath: "src/lib/thing.ts" }),
    ).toEqual({ name: "plan", source: "declared" });
  });

  it("falls back to the path when nothing was declared", () => {
    expect(
      resolveDiffRole({ declared: undefined, writtenPath: "docs/plans/a.md" }),
    ).toEqual({ name: "plan", source: "inferred" });
  });

  it("keeps a declared role's strength even when the path agrees", () => {
    // Both agree, so the result must be the stronger of the two — otherwise
    // the UI would show a dotted "guessed" affordance for a stated fact.
    expect(
      resolveDiffRole({ declared: "plan", writtenPath: "docs/plans/a.md" }),
    ).toEqual({ name: "plan", source: "declared" });
  });

  it("is null when neither source says anything", () => {
    expect(resolveDiffRole({ declared: null, writtenPath: "src/a.ts" })).toBeNull();
  });

  it("falls back to the path when the declaration is invalid", () => {
    // A bad declaration is not a veto: the path evidence still stands.
    expect(
      resolveDiffRole({ declared: "nonsense", writtenPath: "docs/plans/a.md" }),
    ).toEqual({ name: "plan", source: "inferred" });
  });
});
