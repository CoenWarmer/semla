/**
 * Per-test-file environment isolation.
 *
 * Runs inside each worker before the test file it precedes, which is the only
 * place an env var reliably reaches the code under test: vitest workers are
 * separate from the main process, so a `globalSetup` mutation of process.env
 * does not necessarily arrive here.
 *
 * PI_WORKFLOW_HOME is redirected because workflow state is keyed by cwd but
 * rooted at the home directory. A test running against a `mkdtemp` cwd got an
 * isolated key and then wrote it into the operator's real ~/.pi/workflows,
 * where it outlived the temp directory it described and nothing collected it.
 * By the time this was noticed that directory held 1,931 project directories,
 * 127 MB, all but one describing a path that no longer existed.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

const workflowHome = mkdtempSync(join(tmpdir(), "semla-wf-home-"));
process.env.PI_WORKFLOW_HOME = workflowHome;

afterAll(() => {
  rmSync(workflowHome, { recursive: true, force: true });
});
