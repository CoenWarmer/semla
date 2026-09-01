/**
 * Make node-pty's prebuilt `spawn-helper` executable.
 *
 * node-pty ships prebuilt binaries per platform, and on macOS the helper it
 * exec's to open a PTY arrives from the tarball as 0644. Its own post-install
 * script only chmods `build/Release`, which exists when the module is compiled
 * from source and not when a prebuild is used — so a plain install leaves the
 * helper unexecutable and every spawn fails with `posix_spawnp failed`, an
 * error that says nothing about permissions.
 *
 * Idempotent, and silent when there is nothing to fix: no node-pty, no
 * prebuilds directory, or a platform that does not use the helper at all.
 */

import { chmodSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const PREBUILDS = join(process.cwd(), "node_modules", "node-pty", "prebuilds");

if (process.platform !== "win32" && existsSync(PREBUILDS)) {
  for (const dir of readdirSync(PREBUILDS)) {
    const helper = join(PREBUILDS, dir, "spawn-helper");
    if (!existsSync(helper)) continue;

    // Only touch it when it is not already executable, so a repeat install
    // prints nothing.
    const mode = statSync(helper).mode;
    if ((mode & 0o111) === 0) {
      chmodSync(helper, mode | 0o755);
      console.log(`fixed node-pty spawn-helper permissions (${dir})`);
    }
  }
}
