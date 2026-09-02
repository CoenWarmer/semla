/**
 * The two things that can go wrong here are quiet rather than loud: a PATH entry
 * appended instead of prepended (a stale global server wins over the pinned one)
 * and a PATH that grows on every call (harmless until it is not). Both are
 * asserted rather than assumed, because neither shows up as a failure — only as
 * code answers that are subtly worse than they should be.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  describeLanguageServers,
  ensureLanguageServersOnPath,
  languageServerBinDirs,
  localBinDir,
  resolveLanguageServers,
  shimBinDir,
  withLocalBin,
} from "./language-servers.ts";

const originalPath = process.env.PATH;
afterEach(() => {
  process.env.PATH = originalPath;
});

/**
 * A fake project root holding the named binaries.
 *
 * `where` picks the directory, because which of the two a server is found in is
 * itself part of the contract: TypeScript comes from the repository's shim
 * directory, anything installed as a devDependency from node_modules/.bin.
 */
const projectWith = (binaries: string[], where: "shim" | "modules" = "shim") => {
  const root = mkdtempSync(join(tmpdir(), "semla-ls-"));
  const bin = where === "shim" ? shimBinDir(root) : localBinDir(root);
  mkdirSync(bin, { recursive: true });
  for (const binary of binaries) writeFileSync(join(bin, binary), "", "utf8");
  return root;
};

describe("withLocalBin", () => {
  it("prepends, so a pinned server outranks a global one", () => {
    expect(withLocalBin(`/usr/bin${delimiter}/bin`, "/repo/node_modules/.bin")).toBe(
      `/repo/node_modules/.bin${delimiter}/usr/bin${delimiter}/bin`,
    );
  });

  it("does not add the directory twice", () => {
    const once = withLocalBin("/usr/bin", "/repo/node_modules/.bin");
    expect(withLocalBin(once, "/repo/node_modules/.bin")).toBe(once);
  });

  it("handles an unset or empty PATH", () => {
    expect(withLocalBin(undefined, "/repo/node_modules/.bin")).toBe(
      "/repo/node_modules/.bin",
    );
    expect(withLocalBin("", "/repo/node_modules/.bin")).toBe(
      "/repo/node_modules/.bin",
    );
  });
});

describe("resolveLanguageServers", () => {
  it("separates present binaries from absent ones", () => {
    const root = projectWith(["typescript-language-server"]);

    expect(
      resolveLanguageServers(languageServerBinDirs(root), {
        python: "pyright-langserver",
        typescript: "typescript-language-server",
      }),
    ).toEqual({ missing: ["python"], resolved: ["typescript"] });
  });

  it("finds a server in either directory, not just the first", () => {
    const root = projectWith(["pyright-langserver"], "modules");

    expect(
      resolveLanguageServers(languageServerBinDirs(root), {
        python: "pyright-langserver",
      }),
    ).toEqual({ missing: [], resolved: ["python"] });
  });
});

describe("ensureLanguageServersOnPath", () => {
  it("puts the project's bin directories on PATH and reports what resolved", () => {
    const root = projectWith(["typescript-language-server"]);

    const report = ensureLanguageServersOnPath(root);

    expect(report.added).toBe(true);
    expect(report.resolved).toContain("typescript");
    expect(process.env.PATH?.split(delimiter).slice(0, 2)).toEqual([
      shimBinDir(root),
      localBinDir(root),
    ]);
  });

  it("ranks the shim ahead of node_modules, so a global TS 5 server cannot win", () => {
    const root = projectWith(["typescript-language-server"]);
    const entries = ensureLanguageServersOnPath(root).binDirs;

    const path = process.env.PATH?.split(delimiter) ?? [];
    expect(entries[0]).toBe(shimBinDir(root));
    expect(path.indexOf(shimBinDir(root))).toBeLessThan(
      path.indexOf(localBinDir(root)),
    );
  });

  it("is idempotent, so a reload cannot grow PATH without bound", () => {
    const root = projectWith(["typescript-language-server"]);

    ensureLanguageServersOnPath(root);
    const afterFirst = process.env.PATH;
    const second = ensureLanguageServersOnPath(root);

    expect(second.added).toBe(false);
    expect(process.env.PATH).toBe(afterFirst);
  });

  it("still reports a missing server rather than throwing", () => {
    const report = ensureLanguageServersOnPath(projectWith([]));

    expect(report.resolved).toEqual([]);
    expect(report.missing).toContain("typescript");
  });
});

describe("describeLanguageServers", () => {
  it("names the consequence of a missing server, not just its absence", () => {
    const line = describeLanguageServers({
      added: true,
      binDirs: ["/repo/scripts/language-servers", "/repo/node_modules/.bin"],
      missing: ["python"],
      resolved: ["typescript"],
    });

    expect(line).toContain("typescript");
    expect(line).toContain("python");
    expect(line).toContain("structural");
  });

  it("says so plainly when nothing resolved", () => {
    expect(
      describeLanguageServers({
        added: true,
        binDirs: ["/repo/scripts/language-servers", "/repo/node_modules/.bin"],
        missing: ["typescript"],
        resolved: [],
      }),
    ).toContain("no language servers resolved");
  });
});
