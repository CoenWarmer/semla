/**
 * Cross-repo page identity for wiki synthesis.
 *
 * `commitSynthesis` creates a page only when its slug is free, and when the
 * slug is taken it records the name in `entitiesLinked`/`conceptsLinked` and
 * does nothing else — the second source is discarded. Two failures come out of
 * that, and they need opposite fixes:
 *
 *  - Entities are artifacts of one repo. Two repos' `README.md` are two files,
 *    so the first one oriented wins the slug and the other never gets a page.
 *    Namespacing the *title* keeps them apart. It has to be the title rather
 *    than the path, because the package derives the path from `slugify(title)`
 *    and dedupes on it — relocating pages afterwards would blind that check and
 *    make a repo's own second source overwrite its first.
 *  - Concepts are repo-independent. "TypeScript project references" is one idea
 *    both repos have, and the right outcome is one page attesting to both, not
 *    two pages or one that pretends the second repo never mentioned it.
 *
 * What is merged is provenance, not prose: the source list, the repo, and the
 * updated date. Reconciling two definitions takes judgement, which is what the
 * consolidate skill is for.
 */

/** Minimal shape of the synthesis payload this module rewrites. */
export interface SynthesisEntity {
  title: string;
  description?: string;
}

export interface SynthesisLike {
  entities?: SynthesisEntity[];
  concepts?: unknown[];
}

/**
 * Qualify an entity title with its repo.
 *
 * Applied to every entity, not only ones that would collide: collision-only
 * naming makes a page's id depend on which repo was oriented first, so links
 * and recall would shift under a vault that is merely rebuilt in a different
 * order.
 */
export function namespacedEntityTitle(title: string, repo: string): string {
  const trimmed = title.trim();
  const prefix = `${repo} `;
  return trimmed.toLowerCase().startsWith(prefix.toLowerCase())
    ? trimmed
    : `${prefix}${trimmed}`;
}

/** Qualify every entity in a synthesis payload, leaving concepts untouched. */
export function withNamespacedEntities<T extends SynthesisLike>(
  data: T,
  repo: string,
): T {
  if (!Array.isArray(data.entities) || data.entities.length === 0) return data;
  return {
    ...data,
    entities: data.entities.map((entity) => ({
      ...entity,
      title: namespacedEntityTitle(entity.title, repo),
    })),
  };
}

const isFence = (line: string) => line.trim() === "---";
const repoKey = /^repo\s*:/;

function findFence(lines: string[], open: number): number {
  for (let i = open + 1; i < lines.length; i += 1) {
    if (isFence(lines[i]!)) return i;
  }
  return -1;
}

/** Repo values already declared, whether written as a scalar or a YAML list. */
function declaredRepos(value: string): string[] {
  const raw = value.trim();
  if (!raw) return [];
  if (!raw.startsWith("[")) return [raw.replace(/^["']|["']$/g, "")];
  return raw
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((item) => item.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

const formatRepos = (repos: string[]): string =>
  repos.length === 1 ? repos[0]! : `[${repos.join(", ")}]`;

export interface MergeInput {
  sourceId: string;
  /** Repo of the session committing this synthesis, when known. */
  repo: string | null;
  date: string;
}

export interface MergeOutcome {
  changed: boolean;
  content: string;
}

/**
 * Record that another source also attests to an existing page.
 *
 * Frontmatter only — title, description and body are left exactly as the first
 * writer left them.
 */
export function mergeProvenance(markdown: string, input: MergeInput): MergeOutcome {
  const unchanged: MergeOutcome = { changed: false, content: markdown };

  const lines = markdown.split("\n");
  if (!isFence(lines[0] ?? "")) return unchanged;
  const close = findFence(lines, 0);
  if (close === -1) return unchanged;

  const next = [...lines];
  let changed = false;

  // ── sources: append unless this source is already listed ──────────────────
  const alreadyCited = next
    .slice(1, close)
    .some((line) => line.includes(input.sourceId));

  if (!alreadyCited) {
    const entry = [
      `  - id: ${input.sourceId}`,
      `    resource: /sources/${input.sourceId}.md`,
    ];
    const sourcesAt = next.findIndex(
      (line, i) => i > 0 && i < close && /^sources\s*:/.test(line),
    );

    if (sourcesAt === -1) {
      next.splice(close, 0, "sources:", ...entry);
    } else {
      // Insert after the last line of the existing list, which is indented.
      let end = sourcesAt + 1;
      while (end < close && /^\s+/.test(next[end] ?? "")) end += 1;
      next.splice(end, 0, ...entry);
    }
    changed = true;
  }

  const shift = next.length - lines.length;
  const closeNow = close + shift;

  // ── repo: widen an existing tag; never introduce one ──────────────────────
  // A page with no repo yet has not been attributed at all — the turn-end
  // lineage sweep owns that, and it will read the sources list this merge just
  // extended, arriving at every repo that attests to the page. Writing a single
  // repo here would preempt that with a narrower answer, and since the sweep
  // never overwrites an existing tag, the other repo would be lost for good.
  if (input.repo) {
    const repoAt = next.findIndex(
      (line, i) => i > 0 && i < closeNow && repoKey.test(line),
    );
    if (repoAt !== -1) {
      const current = declaredRepos(next[repoAt]!.replace(repoKey, ""));
      if (!current.includes(input.repo)) {
        next[repoAt] = `repo: ${formatRepos([...new Set([...current, input.repo])].sort())}`;
        changed = true;
      }
    }
  }

  if (!changed) return unchanged;

  // ── updated: only meaningful once something else actually changed ─────────
  const updatedAt = next.findIndex(
    (line, i) => i > 0 && i < next.length && /^updated\s*:/.test(line),
  );
  if (updatedAt !== -1) next[updatedAt] = `updated: ${input.date}`;

  return { changed: true, content: next.join("\n") };
}
