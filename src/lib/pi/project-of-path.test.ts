import { describe, expect, it } from "vitest";

import { projectOfPath } from "@/lib/pi/project-of-path";

const ROOT = "/Users/x/Dev";
const PROJECTS = new Set(["semla", "kibana", "semantic-code-search"]);

const owner = (path: string) => projectOfPath(path, ROOT, PROJECTS);

describe("projectOfPath", () => {
  it("resolves an absolute path to the project containing it", () => {
    expect(owner("/Users/x/Dev/semla/src/lib/pi/session-meta.ts")).toBe("semla");
  });

  it("resolves a path relative to the workspace root, which is the agent's cwd", () => {
    expect(owner("semla/src/lib/pi/session-meta.ts")).toBe("semla");
    expect(owner("./semla/package.json")).toBe("semla");
  });

  it("resolves the project directory itself", () => {
    expect(owner("/Users/x/Dev/semla")).toBe("semla");
    expect(owner("semla")).toBe("semla");
  });

  it("attaches the top-level project for a write inside a nested checkout", () => {
    // The real case: semantic-code-search vendors whole repositories under
    // .repos/, and those are not projects the rest of the app can address.
    expect(
      owner("/Users/x/Dev/semantic-code-search/.repos/elastic_kibana/src/foo.ts"),
    ).toBe("semantic-code-search");
  });

  it("has no project for a first-level directory that is not a repository", () => {
    expect(owner("/Users/x/Dev/scratch/notes.md")).toBeNull();
  });

  it("has no project for the workspace root itself", () => {
    expect(owner("/Users/x/Dev")).toBeNull();
    expect(owner("")).toBeNull();
  });

  it("refuses a path that climbs out of the workspace", () => {
    expect(owner("/Users/x/Other/semla/foo.ts")).toBeNull();
    expect(owner("../Other/semla/foo.ts")).toBeNull();
    expect(owner("/etc/passwd")).toBeNull();
    expect(owner("semla/../../Other/foo.ts")).toBeNull();
  });

  it("is not fooled by a sibling whose name starts the same way", () => {
    // "Devil" shares a prefix with "Dev"; a startsWith check would pass it.
    expect(projectOfPath("/Users/x/Devil/semla/foo.ts", ROOT, PROJECTS)).toBeNull();
  });

  it("is not fooled by a directory whose name starts like a project's", () => {
    expect(owner("/Users/x/Dev/semla-old/foo.ts")).toBeNull();
  });

  it("normalises away redundant segments rather than failing on them", () => {
    expect(owner("/Users/x/Dev/./semla/src/../package.json")).toBe("semla");
  });

  it("has no project when the workspace lists none", () => {
    expect(projectOfPath("/Users/x/Dev/semla/foo.ts", ROOT, new Set())).toBeNull();
  });
});
