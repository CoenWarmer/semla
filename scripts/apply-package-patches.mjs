/**
 * Re-apply this repository's patches to installed packages.
 *
 * `@zosmaai/pi-llm-wiki` is patched. It has to be: the wiki extension only
 * hands wiki_ingest to Semla's workflow bridge because a patch adds the
 * `Symbol.for("semla.wiki-ingest-dispatcher")` hook that wiki-ingest-bridge.ts
 * installs a dispatcher into, and two of its tools are switched from
 * background to synchronous so the agent can act on their result in the same
 * turn.
 *
 * Those edits lived only in `node_modules` — untracked, and reproducible by
 * nothing. They survived
 * only because npm does not re-extract a package that already matches the
 * lockfile, so a `npm ci`, a fresh clone, or one cache miss would have removed
 * them and left wiki_ingest silently falling back to inline synthesis. The
 * failure has no error: the bridge installs a dispatcher, and the patched line
 * that would have called it is simply not there.
 *
 * So the patches are committed under `patches/` and re-applied here, on every
 * install, after the trees are in place.
 *
 * Deliberately strict. A patch that does not apply, or a package whose version
 * has moved away from the pin the patch was cut against, exits non-zero rather
 * than leaving a half-patched tree — because the thing being protected against
 * is precisely a silent absence.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const PATCH_DIR = join(ROOT, "patches");

/**
 * Dependency trees a patched package may be installed in, in search order.
 * There is one, now that `.pi/npm` is gone; `.pi/packages/semla-otel` installs
 * its own but nothing there is patched. A list rather than a constant so
 * adding a tree does not mean rewriting the lookup.
 */
const TREES = ["node_modules"];

/** `@scope+name+1.2.3.patch` -> package `@scope/name`, pinned at `1.2.3`. */
const parsePatchName = (file) => {
  const match = /^(.+)\+(\d+\.\d+\.\d+)\.patch$/.exec(file);
  if (!match) return null;

  const [, encodedName, version] = match;
  const parts = encodedName.split("+");
  const name = parts.length === 2 ? `${parts[0]}/${parts[1]}` : encodedName;
  return { name, version };
};

const findInstalled = (name) => {
  for (const tree of TREES) {
    const dir = join(ROOT, tree, name);
    if (existsSync(join(dir, "package.json"))) return dir;
  }
  return null;
};

/** `git apply` resolves --directory against the repo, so keep it relative. */
const gitApply = (args) =>
  execFileSync("git", ["apply", ...args], { cwd: ROOT, stdio: "pipe" });

const applies = (args) => {
  try {
    gitApply(["--check", ...args]);
    return true;
  } catch {
    return false;
  }
};

const patches = existsSync(PATCH_DIR)
  ? readdirSync(PATCH_DIR).filter((file) => file.endsWith(".patch")).sort()
  : [];

let failed = false;

for (const file of patches) {
  const parsed = parsePatchName(file);
  if (!parsed) {
    console.error(
      `[patches] ${file}: expected <scope>+<name>+<version>.patch, skipping`,
    );
    failed = true;
    continue;
  }

  const { name, version } = parsed;
  const dir = findInstalled(name);

  if (!dir) {
    // Not an error: a patch can outlive the install it targets while a tree is
    // being moved. Loud enough to notice.
    console.warn(`[patches] ${name} is not installed — ${file} not applied`);
    continue;
  }

  const installed = JSON.parse(
    readFileSync(join(dir, "package.json"), "utf8"),
  ).version;

  if (installed !== version) {
    console.error(
      `[patches] ${name} is installed at ${installed} but ${file} was cut ` +
        `against ${version}. Re-cut the patch against the new version rather ` +
        "than letting it apply to code it was not written for.",
    );
    failed = true;
    continue;
  }

  const target = ["-p1", "--directory", relative(ROOT, dir), join("patches", file)];

  // Reverse-applies cleanly means it is already there. Checked first so a
  // repeat install is silent rather than a failure.
  if (applies(["--reverse", ...target])) continue;

  if (!applies(target)) {
    console.error(
      `[patches] ${file} does not apply to ${name}@${installed} and is not ` +
        "already applied. The package may have changed under it; re-cut the patch.",
    );
    failed = true;
    continue;
  }

  gitApply(target);
  console.log(`[patches] applied ${file} to ${name}@${installed}`);
}

if (failed) process.exit(1);
