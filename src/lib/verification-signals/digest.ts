/**
 * The staleness key for verification signals.
 *
 * Not a commit sha and not the code-index tree root, for two different
 * reasons. A sha is blind to `~/.semla/agent/mcp.json`, which is per-machine
 * and outside every project, so per-project commits provably cannot see MCP
 * config drift. A tree root moves on every source edit, which is not phase
 * 3's business — signals come from manifests and tool configs.
 *
 * So: a hash over exactly the files that were read. Each input is folded as
 * `label\0<sha256 of bytes>`, and labels are sorted before folding, so the
 * digest depends on the *set* of inputs and their contents but not on the
 * order discovery happened to visit them. A label is project-relative (or
 * `mcp.json` for the out-of-repo one) rather than absolute, so the same repo
 * checked out at two paths does not report drift.
 *
 * A missing file is folded as an explicit absent marker rather than skipped:
 * deleting `vitest.config.mts` has to move the digest, and a skipped input
 * makes its deletion indistinguishable from it never having existed.
 */

import { createHash } from "node:crypto";

export interface DigestInput {
  /** Machine-independent name for the file, e.g. `package.json`. */
  label: string;
  /** File bytes, or null when the file does not exist. */
  content: string | null;
}

/** Marker folded for an input that was looked for and not found. */
const ABSENT = "\u0000absent";

export function computeInputsDigest(inputs: DigestInput[]): {
  digest: string;
  labels: string[];
} {
  const sorted = [...inputs].sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
  const hash = createHash("sha256");
  const labels: string[] = [];

  for (const input of sorted) {
    // Duplicate labels would make the digest depend on visit order again.
    if (labels.includes(input.label)) continue;
    labels.push(input.label);
    hash.update(input.label);
    hash.update("\u0000");
    hash.update(
      input.content === null
        ? ABSENT
        : createHash("sha256").update(input.content).digest("hex"),
    );
    hash.update("\n");
  }

  return { digest: hash.digest("hex"), labels };
}
