import { describe, expect, it } from "vitest";

import {
  attachProject,
  detachProject,
  orderLinks,
  primaryPath,
  setPrimary,
  type ProjectLink,
} from "@/lib/pi/session-project-links";

const T1 = "2026-09-01T10:00:00.000Z";
const T2 = "2026-09-01T11:00:00.000Z";
const T3 = "2026-09-01T12:00:00.000Z";

const link = (over: Partial<ProjectLink> & { path: string }): ProjectLink => ({
  origin: "observed",
  isPrimary: false,
  firstAttachedAt: T1,
  lastTouchedAt: T1,
  ...over,
});

const paths = (links: readonly ProjectLink[]) => links.map((l) => l.path);

describe("attachProject", () => {
  it("adopts the first project as the anchor, so an unanchored session gains one", () => {
    const links = attachProject([], { path: "semla", origin: "observed", at: T1 });

    expect(links).toHaveLength(1);
    expect(links[0].isPrimary).toBe(true);
    expect(primaryPath(links)).toBe("semla");
  });

  it("leaves the anchor alone when a second project arrives", () => {
    const first = attachProject([], { path: "semla", origin: "explicit", at: T1 });
    const both = attachProject(first, { path: "kibana", origin: "observed", at: T2 });

    expect(primaryPath(both)).toBe("semla");
    expect(paths(both)).toEqual(["semla", "kibana"]);
  });

  it("refreshes lastTouchedAt without duplicating an existing link", () => {
    const first = attachProject([], { path: "semla", origin: "observed", at: T1 });
    const again = attachProject(first, { path: "semla", origin: "observed", at: T2 });

    expect(again).toHaveLength(1);
    expect(again[0].firstAttachedAt).toBe(T1);
    expect(again[0].lastTouchedAt).toBe(T2);
  });

  it("upgrades an observed link to explicit when the user attaches it", () => {
    const observed = attachProject([], { path: "semla", origin: "observed", at: T1 });
    const chosen = attachProject(observed, { path: "semla", origin: "explicit", at: T2 });

    expect(chosen[0].origin).toBe("explicit");
  });

  it("never downgrades an explicit link when the agent writes to it", () => {
    // Otherwise a write would quietly turn a removable link into a permanent one.
    const chosen = attachProject([], { path: "semla", origin: "explicit", at: T1 });
    const written = attachProject(chosen, { path: "semla", origin: "observed", at: T2 });

    expect(written[0].origin).toBe("explicit");
  });

  it("moves the anchor when a link is attached as primary", () => {
    const first = attachProject([], { path: "semla", origin: "explicit", at: T1 });
    const moved = attachProject(first, {
      path: "kibana",
      origin: "explicit",
      at: T2,
      primary: true,
    });

    expect(primaryPath(moved)).toBe("kibana");
    expect(moved.filter((l) => l.isPrimary)).toHaveLength(1);
  });

  it("does not mutate the list it was given", () => {
    const before: ProjectLink[] = [];
    attachProject(before, { path: "semla", origin: "observed", at: T1 });

    expect(before).toEqual([]);
  });
});

describe("setPrimary", () => {
  it("moves the anchor and leaves exactly one", () => {
    const links = [
      link({ path: "semla", isPrimary: true, origin: "explicit" }),
      link({ path: "kibana", firstAttachedAt: T2 }),
    ];

    const moved = setPrimary(links, "kibana");

    expect(primaryPath(moved)).toBe("kibana");
    expect(moved.filter((l) => l.isPrimary)).toHaveLength(1);
  });

  it("promotes an observed link, which is the point of it being separate from origin", () => {
    const links = [link({ path: "kibana", origin: "observed" })];

    expect(primaryPath(setPrimary(links, "kibana"))).toBe("kibana");
  });

  it("leaves the list alone for a project the session has no link to", () => {
    const links = [link({ path: "semla", isPrimary: true })];

    expect(setPrimary(links, "elsewhere")).toEqual(links);
  });
});

describe("detachProject", () => {
  it("removes an explicitly attached project", () => {
    const links = [
      link({ path: "semla", isPrimary: true, origin: "explicit" }),
      link({ path: "kibana", origin: "explicit", firstAttachedAt: T2 }),
    ];

    expect(paths(detachProject(links, "kibana")!)).toEqual(["semla"]);
  });

  it("refuses to remove an observed link, because the write really happened", () => {
    const links = [link({ path: "kibana", origin: "observed" })];

    expect(detachProject(links, "kibana")).toBeNull();
  });

  it("is a no-op for a project that is not linked", () => {
    const links = [link({ path: "semla", origin: "explicit" })];

    expect(detachProject(links, "elsewhere")).toEqual(links);
  });

  it("leaves the session anchorless when the anchor is removed", () => {
    const links = [
      link({ path: "semla", isPrimary: true, origin: "explicit" }),
      link({ path: "kibana", origin: "observed", firstAttachedAt: T2 }),
    ];

    const left = detachProject(links, "semla")!;

    expect(primaryPath(left)).toBeNull();
    expect(paths(left)).toEqual(["kibana"]);
  });

  it("lets the next attach adopt the anchor again", () => {
    const links = [link({ path: "semla", isPrimary: true, origin: "explicit" })];
    const empty = detachProject(links, "semla")!;

    const next = attachProject(empty, { path: "kibana", origin: "observed", at: T3 });

    expect(primaryPath(next)).toBe("kibana");
  });
});

describe("orderLinks", () => {
  it("puts the anchor first and the rest oldest first", () => {
    const links = [
      link({ path: "c", firstAttachedAt: T3 }),
      link({ path: "a", firstAttachedAt: T2 }),
      link({ path: "b", isPrimary: true, firstAttachedAt: T3 }),
    ];

    expect(paths(orderLinks(links))).toEqual(["b", "a", "c"]);
  });

  it("breaks a timestamp tie by path, so the order never wobbles", () => {
    const links = [link({ path: "z" }), link({ path: "a" })];

    expect(paths(orderLinks(links))).toEqual(["a", "z"]);
  });
});
