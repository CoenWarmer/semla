/**
 * Change detection for an indexed tree.
 *
 * The article this design follows uses a Merkle tree: file hashes folded
 * bottom-up into one root, so a client and a server can find the changed
 * subtrees by exchanging a few hashes instead of the whole file list. That
 * payoff is real and it is remote-specific — it buys nothing here, because
 * every file has to be hashed locally to know its hash regardless, and the
 * comparison is against a manifest sitting on the same disk.
 *
 * So this is the flat half of that idea: a map of path -> content hash, plus a
 * root over the sorted pairs that answers "did anything at all change?" in one
 * comparison. The tree fold is deferred until there is a remote to talk to.
 * Recorded rather than silently omitted, because the next person will read the
 * article and wonder where the tree went — see docs/plans/code-index.md §5.
 *
 * The root covers paths as well as contents, so a pure rename moves the root
 * even though no content hash changed. A rename does invalidate the index:
 * chunks cite `path`, and a citation to a file that no longer exists under that
 * name is exactly the stale answer §3.1 exists to prevent.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

/** Project-relative POSIX path -> sha256 of the file's bytes. */
export type Fingerprints = Record<string, string>;

export interface FingerprintDiff {
  /** Present now, absent from the indexed manifest. */
  added: string[];
  /** Present in both, different content hash. */
  changed: string[];
  /** In the indexed manifest, gone from disk. */
  removed: string[];
}

/** True when nothing needs re-embedding and nothing needs deleting. */
export function isUnchanged(diff: FingerprintDiff): boolean {
  return (
    diff.added.length === 0 &&
    diff.changed.length === 0 &&
    diff.removed.length === 0
  );
}

export function hashContent(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Hash every file, keyed by its project-relative path.
 *
 * Reads are concurrent but bounded: a project with thousands of files will
 * otherwise open thousands of descriptors at once and fail on EMFILE, which
 * presents as an unreadable tree rather than as the resource limit it is.
 */
export async function fingerprintFiles(
  root: string,
  relativePaths: readonly string[],
  { concurrency = 32 }: { concurrency?: number } = {},
): Promise<{ fingerprints: Fingerprints; unreadable: string[] }> {
  const fingerprints: Fingerprints = {};
  const unreadable: string[] = [];
  const queue = [...relativePaths];

  const workers = Array.from(
    { length: Math.min(concurrency, queue.length) },
    async () => {
      for (;;) {
        const relativePath = queue.pop();
        if (relativePath === undefined) return;
        try {
          const bytes = await readFile(`${root}/${relativePath}`);
          fingerprints[relativePath] = hashContent(bytes);
        } catch {
          unreadable.push(relativePath);
        }
      }
    },
  );

  await Promise.all(workers);
  return { fingerprints, unreadable };
}

/**
 * One hash standing for the whole tree.
 *
 * Sorted so the root does not depend on directory iteration order, which is
 * neither stable across platforms nor across two runs on the same one.
 */
export function treeRoot(fingerprints: Fingerprints): string {
  const digest = createHash("sha256");
  for (const path of Object.keys(fingerprints).sort()) {
    digest.update(path);
    digest.update("\0");
    digest.update(fingerprints[path]);
    digest.update("\n");
  }
  return digest.digest("hex");
}

export function diffFingerprints(
  indexed: Fingerprints,
  current: Fingerprints,
): FingerprintDiff {
  const added: string[] = [];
  const changed: string[] = [];
  const removed: string[] = [];

  for (const [path, hash] of Object.entries(current)) {
    const previous = indexed[path];
    if (previous === undefined) added.push(path);
    else if (previous !== hash) changed.push(path);
  }
  for (const path of Object.keys(indexed)) {
    if (!(path in current)) removed.push(path);
  }

  return {
    added: added.sort(),
    changed: changed.sort(),
    removed: removed.sort(),
  };
}
