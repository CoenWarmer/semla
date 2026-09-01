import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readSessionMeta, writeSessionMeta, type ProjectLink } from "@/lib/pi/session-meta";
import { recordProjectTouch, writtenPath } from "@/lib/pi/session-project-attach";

const dir = () => mkdtempSync(join(tmpdir(), "semla-attach-"));

/** Collects what would have gone to Postgres, without going there. */
const spyMirror = () => {
  const calls: ProjectLink[][] = [];
  return {
    calls,
    fn: async (_id: string, links: readonly ProjectLink[]) => {
      calls.push([...links]);
    },
  };
};

describe("writtenPath", () => {
  it("reads the path an edit or a write is about to change", () => {
    expect(writtenPath("edit", { path: "semla/src/a.ts", edits: [] })).toBe("semla/src/a.ts");
    expect(writtenPath("write", { path: "semla/b.ts", content: "x" })).toBe("semla/b.ts");
  });

  it("ignores every tool that only reads", () => {
    // Attaching on reads would link a project the moment the agent grepped it,
    // and the file browser would link one whenever somebody opened a file.
    expect(writtenPath("read", { path: "semla/src/a.ts" })).toBeNull();
    expect(writtenPath("grep", { path: "semla" })).toBeNull();
    expect(writtenPath("find", { path: "semla" })).toBeNull();
    expect(writtenPath("ls", { path: "semla" })).toBeNull();
  });

  it("ignores bash, whose writes carry no typed path", () => {
    // The known gap: `git commit`, `sed -i`, `mv` are invisible here.
    expect(writtenPath("bash", { command: "sed -i '' s/a/b/ semla/x.ts" })).toBeNull();
  });

  it("is unbothered by arguments that are missing or the wrong shape", () => {
    expect(writtenPath("edit", null)).toBeNull();
    expect(writtenPath("edit", {})).toBeNull();
    expect(writtenPath("edit", { path: 42 })).toBeNull();
    expect(writtenPath("edit", { path: "   " })).toBeNull();
  });
});

describe("recordProjectTouch", () => {
  it("attaches an observed link and mirrors it", async () => {
    const d = dir();
    const mirror = spyMirror();
    writeSessionMeta("s1", { title: "t" }, d);

    const changed = await recordProjectTouch("s1", "semla", {
      at: "2026-09-01T10:00:00.000Z",
      dir: d,
      mirror: mirror.fn,
    });

    expect(changed).toBe(true);
    const links = readSessionMeta("s1", d)!.projects;
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ path: "semla", origin: "observed", isPrimary: true });
    expect(mirror.calls).toHaveLength(1);
  });

  it("does not mirror again when nothing about the links changed", async () => {
    const d = dir();
    const mirror = spyMirror();
    writeSessionMeta("s1", { title: "t" }, d);
    const at = "2026-09-01T10:00:00.000Z";

    await recordProjectTouch("s1", "semla", { at, dir: d, mirror: mirror.fn });
    const changed = await recordProjectTouch("s1", "semla", { at, dir: d, mirror: mirror.fn });

    expect(changed).toBe(false);
    expect(mirror.calls).toHaveLength(1);
  });

  it("moves lastTouchedAt when the same project is written again later", async () => {
    const d = dir();
    const mirror = spyMirror();
    writeSessionMeta("s1", { title: "t" }, d);

    await recordProjectTouch("s1", "semla", {
      at: "2026-09-01T10:00:00.000Z",
      dir: d,
      mirror: mirror.fn,
    });
    await recordProjectTouch("s1", "semla", {
      at: "2026-09-01T11:00:00.000Z",
      dir: d,
      mirror: mirror.fn,
    });

    const link = readSessionMeta("s1", d)!.projects[0];
    expect(link.firstAttachedAt).toBe("2026-09-01T10:00:00.000Z");
    expect(link.lastTouchedAt).toBe("2026-09-01T11:00:00.000Z");
  });

  it("accumulates a second project without disturbing the anchor", async () => {
    const d = dir();
    const mirror = spyMirror();
    writeSessionMeta("s1", { title: "t" }, d);

    await recordProjectTouch("s1", "semla", { at: "2026-09-01T10:00:00.000Z", dir: d, mirror: mirror.fn });
    await recordProjectTouch("s1", "kibana", { at: "2026-09-01T11:00:00.000Z", dir: d, mirror: mirror.fn });

    const links = readSessionMeta("s1", d)!.projects;
    expect(links.map((l) => l.path)).toEqual(["semla", "kibana"]);
    expect(links.filter((l) => l.isPrimary).map((l) => l.path)).toEqual(["semla"]);
  });

  it("never downgrades a project the user chose", async () => {
    const d = dir();
    const mirror = spyMirror();
    writeSessionMeta(
      "s1",
      {
        projects: [
          {
            path: "semla",
            origin: "explicit",
            isPrimary: true,
            firstAttachedAt: "2026-08-30T10:00:00.000Z",
            lastTouchedAt: "2026-08-30T10:00:00.000Z",
          },
        ],
      },
      d,
    );

    await recordProjectTouch("s1", "semla", {
      at: "2026-09-01T10:00:00.000Z",
      dir: d,
      mirror: mirror.fn,
    });

    expect(readSessionMeta("s1", d)!.projects[0].origin).toBe("explicit");
  });

  it("does nothing for a session with no record", async () => {
    const d = dir();
    const mirror = spyMirror();

    expect(await recordProjectTouch("ghost", "semla", { dir: d, mirror: mirror.fn })).toBe(false);
    expect(mirror.calls).toHaveLength(0);
  });
});
