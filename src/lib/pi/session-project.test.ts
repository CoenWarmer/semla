import { describe, expect, it } from "vitest";

import { impliedLinks, projectAbsolutePath, projectPrefix } from "@/lib/pi/session-project";

describe("projectPrefix", () => {
  it("reports a project inside the workspace as a relative path", () => {
    expect(projectPrefix("/Users/x/Dev", "/Users/x/Dev/semla")).toBe("semla");
    expect(projectPrefix("/Users/x/Dev", "/Users/x/Dev/work/api")).toBe("work/api");
  });

  it("has no prefix for a session without a project", () => {
    expect(projectPrefix("/Users/x/Dev", null)).toBeNull();
  });

  it("has no prefix when the project is the workspace root itself", () => {
    expect(projectPrefix("/Users/x/Dev", "/Users/x/Dev")).toBeNull();
  });

  it("refuses a project outside the workspace rather than escaping the root", () => {
    expect(projectPrefix("/Users/x/Dev", "/Users/x/Other")).toBeNull();
    expect(projectPrefix("/Users/x/Dev", "/etc")).toBeNull();
  });

  it("is not fooled by a sibling whose name starts the same way", () => {
    expect(projectPrefix("/Users/x/Dev", "/Users/x/Devil/semla")).toBeNull();
  });
});

/**
 * Sessions created before the relation existed carry only `projectPath`. They
 * have to keep showing their project, so it is converted on read rather than
 * backfilled — the workspace root is a runtime value, and read time is the only
 * place that reliably knows it.
 */
describe("impliedLinks", () => {
  const AT = "2026-08-30T10:00:00.000Z";

  it("turns a legacy project path into one explicit, primary link", () => {
    const links = impliedLinks("/Users/x/Dev", "/Users/x/Dev/semla", AT);

    expect(links).toEqual([
      {
        path: "semla",
        origin: "explicit",
        isPrimary: true,
        firstAttachedAt: AT,
        lastTouchedAt: AT,
      },
    ]);
  });

  it("dates the link from the session rather than from now", () => {
    // A provenance record that claims the link is younger than it is would be
    // worse than having no timestamp.
    expect(impliedLinks("/Users/x/Dev", "/Users/x/Dev/semla", AT)[0].firstAttachedAt).toBe(AT);
  });

  it("implies nothing for a session that never had a project", () => {
    expect(impliedLinks("/Users/x/Dev", null, AT)).toEqual([]);
  });

  it("implies nothing for a project outside the workspace root", () => {
    // It has no workspace-relative form, so nothing in the app could address it.
    expect(impliedLinks("/Users/x/Dev", "/Users/x/Other/semla", AT)).toEqual([]);
  });
});

describe("projectAbsolutePath", () => {
  it("resolves a link back to the path git and the wiki shell out to", () => {
    expect(projectAbsolutePath({ path: "semla" }, "/Users/x/Dev")).toBe("/Users/x/Dev/semla");
  });
});
