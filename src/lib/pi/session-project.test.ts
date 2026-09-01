import { describe, expect, it } from "vitest";

import { projectPrefix } from "@/lib/pi/session-project";

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
