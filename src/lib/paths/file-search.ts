/**
 * Ranking for the file browser's filename filter.
 *
 * The browser is rooted in the session's project, but a search is asked across
 * the whole workspace — the point of typing a name is often to reach a file the
 * tree in front of you does not contain. Ranking is what keeps that useful:
 * matches inside the current project come first, everything else underneath, so
 * a wide search never buries the answer you almost certainly meant.
 *
 * Scoring is on the basename before the path. Searching "route" should offer
 * `route.ts` ahead of every file that merely lives under `routes/`.
 */

export type FileMatch = {
  /** Basename, for display. */
  name: string;
  /** Path relative to the workspace root — what the content endpoint takes. */
  path: string;
  /** Whether the file lives inside the session's project. */
  inProject: boolean;
};

/**
 * How well `relPath` answers `query`, lower being better, or null for no match.
 *
 * The bands are deliberately coarse. A finer metric (subsequence distance, say)
 * reorders results as you type in ways that are hard to predict, and the tie
 * break below — shallower paths first — is a better signal than a fuzzier score.
 */
export function matchScore(query: string, relPath: string): number | null {
  const needle = query.trim().toLowerCase();
  if (!needle) return null;

  const path = relPath.toLowerCase();
  const name = path.slice(path.lastIndexOf("/") + 1);

  if (name === needle) return 0;
  if (name.startsWith(needle)) return 1;
  if (name.includes(needle)) return 2;
  if (path.includes(needle)) return 3;
  return null;
}

const depth = (path: string) => path.split("/").length;

/**
 * Order two scored matches: project first, then match quality, then the
 * shallower path, then alphabetically so the list is stable between renders.
 */
export function compareMatches(
  a: FileMatch & { score: number },
  b: FileMatch & { score: number },
): number {
  if (a.inProject !== b.inProject) return a.inProject ? -1 : 1;
  if (a.score !== b.score) return a.score - b.score;
  const depthDiff = depth(a.path) - depth(b.path);
  if (depthDiff !== 0) return depthDiff;
  return a.path.localeCompare(b.path);
}

/** Score, drop the misses, sort, and cap. */
export function rankMatches(
  query: string,
  candidates: readonly FileMatch[],
  limit: number,
): FileMatch[] {
  const scored: (FileMatch & { score: number })[] = [];
  for (const candidate of candidates) {
    const score = matchScore(query, candidate.path);
    if (score !== null) scored.push({ ...candidate, score });
  }
  scored.sort(compareMatches);
  return scored
    .slice(0, limit)
    .map(({ inProject, name, path }) => ({ inProject, name, path }));
}
