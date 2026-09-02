/**
 * `.pi/npm` was a second dependency tree with its own lockfile, and it existed
 * for one package: @zosmaai/pi-llm-wiki.
 *
 * That mattered because `npm audit` only ever sees the tree it is run in. The
 * root tree reported "found 0 vulnerabilities" while this one held two
 * high-severity advisories against a *second* copy of the agent runtime — an
 * old 0.73.1 that the wiki's wildcard peer dependency pulled in, carrying a
 * race in pi's `auth.json` writes that can expose stored credentials. Nothing
 * in the repository said so.
 *
 * It is gone: the package is declared at the root, its wildcard peer is aliased
 * onto the runtime this repository already pins, and its patches are committed
 * under `patches/`. This is the guard that it stays gone — a tree is easy to
 * recreate by running `npm install --prefix` somewhere, and the audit it hides
 * from is silent by construction.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe(".pi/npm", () => {
  it("does not exist", () => {
    expect(
      existsSync(join(process.cwd(), ".pi", "npm")),
      "A dependency tree here is invisible to `npm audit` run at the root. If " +
        "something needs it back, add it to scripts/audit-all.mjs in the same " +
        "commit so the number stays visible.",
    ).toBe(false);
  });

  it("is not installed or audited by any script", () => {
    const scripts = (
      JSON.parse(
        readFileSync(join(process.cwd(), "package.json"), "utf8"),
      ) as { scripts: Record<string, string> }
    ).scripts;

    for (const [name, command] of Object.entries(scripts)) {
      expect(command, `${name} still references .pi/npm`).not.toContain(
        ".pi/npm",
      );
    }
  });
});
