/**
 * `.pi/` in this repository is gone, and this is the guard that it stays gone.
 *
 * It held two things. `.pi/npm` was a second dependency tree with its own
 * lockfile, kept for one package — and `npm audit` only ever sees the tree it
 * is run in, so the root said "found 0 vulnerabilities" while that one held two
 * high-severity advisories against a second copy of the pi agent runtime.
 *
 * `.pi/settings.json` was worse, and only became so recently. pi reads a
 * project-scope `settings.json` from its cwd, and Semla's sessions used to run
 * at the workspace root — the parent of every project — where there was no such
 * file. Anchoring a session to its own project (see session-cwd.ts) made this
 * repository's own `.pi/settings.json` live, and its `packages` list told pi to
 * install and load the wiki a *second* time. Measured: nine extensions loaded
 * instead of seven, `.pi/npm` recreated from the registry — unpatched, so the
 * ingest dispatcher hook absent — and fourteen tool-name conflicts. Which copy
 * wins the registration race decides whether wiki_ingest works.
 *
 * That is the same failure PI_AGENT_DIR was introduced to prevent, arriving by
 * a different path: extensions belong in EXTENSION_MANIFEST, where a load is
 * verified, not in a settings file pi discovers on its own.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The directory name itself is not forbidden: `.pi/worktrees/` is where
 * dynamic-workflows puts an isolated worktree, and `.pi/agents/` is a
 * cwd-relative convention it *reads*. Those are fine. What must not come back
 * is a settings file pi acts on, or a dependency tree `npm audit` cannot see.
 */
const FORBIDDEN = [
  [
    ".pi/settings.json",
    "pi reads a project-scope settings.json from its cwd, and sessions now run " +
      "in this repository. A `packages` list there loads extensions that never " +
      "reach EXTENSION_MANIFEST, so nothing verifies them — and the last one " +
      "duplicated an extension the manifest already loads.",
  ],
  [
    ".pi/npm",
    "A second dependency tree is invisible to `npm audit` run at the root. " +
      "Declare extension packages in the root package.json instead.",
  ],
  [
    ".pi/packages",
    "A pi package here loads only through .pi/settings.json, which is the " +
      "mechanism above. Extensions belong in EXTENSION_MANIFEST.",
  ],
] as const;

describe(".pi", () => {
  it.each(FORBIDDEN)("has no %s", (path, why) => {
    expect(existsSync(join(process.cwd(), path)), why).toBe(false);
  });

  it("is not installed, audited or referenced by any script", () => {
    const scripts = (
      JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
        scripts: Record<string, string>;
      }
    ).scripts;

    for (const [name, command] of Object.entries(scripts)) {
      expect(command, `${name} still references .pi/`).not.toContain(".pi/");
    }
  });
});
