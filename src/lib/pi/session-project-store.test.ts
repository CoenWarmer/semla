import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readSessionMeta, writeSessionMeta, type ProjectLink } from "@/lib/pi/session-meta";
import { attachProject, detachProject } from "@/lib/pi/session-project-links";
import { updateSessionProjects } from "@/lib/pi/session-project-store";

const dir = () => mkdtempSync(join(tmpdir(), "semla-store-"));

const spyMirror = () => {
  const calls: ProjectLink[][] = [];
  return {
    calls,
    fn: async (_id: string, links: readonly ProjectLink[]) => {
      calls.push([...links]);
    },
  };
};

const AT = "2026-09-01T10:00:00.000Z";

describe("updateSessionProjects", () => {
  it("writes the change to disk and mirrors it", async () => {
    const d = dir();
    const mirror = spyMirror();
    writeSessionMeta("s1", { title: "t" }, d);

    const result = await updateSessionProjects(
      "s1",
      (links) => attachProject(links, { at: AT, origin: "explicit", path: "semla" }),
      { dir: d, mirror: mirror.fn },
    );

    expect(result).toMatchObject({ status: "ok", changed: true });
    expect(readSessionMeta("s1", d)!.projects.map((l) => l.path)).toEqual(["semla"]);
    expect(mirror.calls).toHaveLength(1);
  });

  it("reports no change, and does not mirror, when the links already say this", async () => {
    const d = dir();
    const mirror = spyMirror();
    writeSessionMeta("s1", { title: "t" }, d);
    const attach = (links: readonly ProjectLink[]) =>
      attachProject(links, { at: AT, origin: "explicit", path: "semla" });

    await updateSessionProjects("s1", attach, { dir: d, mirror: mirror.fn });
    const again = await updateSessionProjects("s1", attach, { dir: d, mirror: mirror.fn });

    expect(again).toMatchObject({ status: "ok", changed: false });
    expect(mirror.calls).toHaveLength(1);
  });

  it("refuses when the update declines, leaving disk untouched", async () => {
    // Detaching an observed link: the caller answers 409 rather than reporting
    // a success that did not happen.
    const d = dir();
    const mirror = spyMirror();
    writeSessionMeta("s1", { title: "t" }, d);
    await updateSessionProjects(
      "s1",
      (links) => attachProject(links, { at: AT, origin: "observed", path: "semla" }),
      { dir: d, mirror: mirror.fn },
    );

    const result = await updateSessionProjects("s1", (links) => detachProject(links, "semla"), {
      dir: d,
      mirror: mirror.fn,
    });

    expect(result).toEqual({ status: "refused" });
    expect(readSessionMeta("s1", d)!.projects).toHaveLength(1);
    expect(mirror.calls).toHaveLength(1);
  });

  it("reports a session with no record rather than creating one", async () => {
    const d = dir();
    const mirror = spyMirror();

    const result = await updateSessionProjects("ghost", (links) => [...links], {
      dir: d,
      mirror: mirror.fn,
    });

    expect(result).toEqual({ status: "missing" });
    expect(readSessionMeta("ghost", d)).toBeNull();
    expect(mirror.calls).toHaveLength(0);
  });

  it("leaves the rest of the record alone", async () => {
    const d = dir();
    const mirror = spyMirror();
    writeSessionMeta("s1", { title: "Keep me", goal: "and me", isRunning: true }, d);

    await updateSessionProjects(
      "s1",
      (links) => attachProject(links, { at: AT, origin: "explicit", path: "semla" }),
      { dir: d, mirror: mirror.fn },
    );

    const meta = readSessionMeta("s1", d)!;
    expect(meta.title).toBe("Keep me");
    expect(meta.goal).toBe("and me");
    expect(meta.isRunning).toBe(true);
  });
});
