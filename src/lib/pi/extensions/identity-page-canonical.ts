/**
 * Canonicalise the pages that name a person or an organisation.
 *
 * These are the only page types that are not artifacts of one repo: the same
 * human authors commits in three repos, the same organisation owns them. The
 * entity naming rule — qualify a title with its repo — is right for a README
 * and wrong for a person, and following it split one human into
 * `nightshift-program Coen Warmer` while `Elastic` became two pages,
 * `catalog-info Elastic` and `nightshift-program Elastic`.
 *
 * Telling the agent not to do that is necessary but has not been sufficient,
 * so this runs after the writes and fixes it mechanically. It needs no
 * heuristic about which pages name people: the page declares `type: person` or
 * `type: organisation` itself, and this acts on nothing else. An earlier
 * version of this idea was rejected precisely because, without a declared
 * type, it would have had to guess — and "two capitalised words" catches
 * `Coen Warmer`, `Elastic Agent` and `React Compiler` alike.
 */

/** Types that name something a repo has, rather than something a repo is. */
export const IDENTITY_TYPES = new Set(["person", "organisation"]);

const FENCE = /^---\s*$/;

function fenceEnd(lines: string[]): number {
  if (!FENCE.test(lines[0] ?? "")) return -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (FENCE.test(lines[index]!)) return index;
  }
  return -1;
}

/** Read one frontmatter field, from the first block only. */
export function readField(markdown: string, key: string): string | null {
  const lines = markdown.split("\n");
  const close = fenceEnd(lines);
  if (close === -1) return null;
  const pattern = new RegExp(`^${key}:\\s*`);
  const line = lines.slice(1, close).find((entry) => pattern.test(entry));
  return line ? line.replace(pattern, "").trim() : null;
}

/**
 * The slug pi-llm-wiki derives from a title.
 *
 * Mirrors `slugify` in the package's utils, with one deliberate difference:
 * a `/` becomes a separator rather than vanishing. The package strips it, so
 * `elastic/kibana` slugs to `elastickibana` and `elastic/catalog-info` to
 * `elasticcatalog-info` — two names fused into one unreadable token, which is
 * where a good share of this vault's Elastic variants came from.
 */
export function slugifyTitle(title: string): string {
  return title
    .replace(/[/\\]/g, " ")
    .toLowerCase()
    .normalize("NFC")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/[\s-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/** Repo slugs a page claims, from `repo: a` or `repo: [a, b]`. */
export function declaredRepos(markdown: string): string[] {
  const raw = readField(markdown, "repo");
  if (!raw) return [];
  if (!raw.startsWith("[")) return [raw];
  return raw
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((item) => item.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

/**
 * Strip a leading repo qualifier from a title.
 *
 * Only the repos the page itself declares are stripped, so a person whose name
 * genuinely begins with a word that happens to match another repo is untouched.
 * Matched case-insensitively because the qualifier is a directory name and the
 * title is prose.
 */
export function canonicalTitle(title: string, repos: readonly string[]): string {
  for (const repo of repos) {
    if (!repo) continue;
    const prefix = `${repo} `;
    if (title.toLowerCase().startsWith(prefix.toLowerCase())) {
      return title.slice(prefix.length).trim();
    }
  }
  return title.trim();
}

export interface CanonicalOutcome {
  /** True when the title in the frontmatter (or an H1) had to change. */
  changed: boolean;
  content: string;
  /** The title this page should carry. */
  title: string;
  /** The filename stem this page belongs at, without extension. */
  slug: string;
}

/**
 * Rewrite a page's title to its canonical, unqualified form.
 *
 * Returns the slug it belongs at so the caller can decide between a rename and
 * a merge; this function never touches the filesystem.
 */
export function canonicaliseIdentityPage(markdown: string): CanonicalOutcome | null {
  const type = readField(markdown, "type");
  if (!type || !IDENTITY_TYPES.has(type)) return null;

  const title = readField(markdown, "title");
  if (!title) return null;

  const wanted = canonicalTitle(title, declaredRepos(markdown));
  const slug = slugifyTitle(wanted);
  if (!slug) return null;

  if (wanted === title) {
    return { changed: false, content: markdown, title, slug };
  }

  // The H1 repeats the title on every page the package writes, so leaving it
  // would show the qualified name to every reader while the frontmatter said
  // otherwise.
  const content = markdown
    .replace(new RegExp(`^title:\\s*${escapeRegExp(title)}\\s*$`, "m"), `title: ${wanted}`)
    .replace(new RegExp(`^#\\s+${escapeRegExp(title)}\\s*$`, "m"), `# ${wanted}`);

  return { changed: true, content, title: wanted, slug };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface WidenOutcome {
  changed: boolean;
  content: string;
}

/**
 * Add repos to a page's `repo:` field without ever removing one.
 *
 * The same widening rule synthesis provenance uses: a page keeps every repo it
 * has already earned and gains any it has not, so folding a duplicate into a
 * canonical page cannot cost that page a claim. Written here rather than
 * borrowed from `mergeProvenance`, which also appends a source entry and
 * would need an empty `sourceId` to be talked out of it.
 */
export function widenRepos(markdown: string, repos: readonly string[]): WidenOutcome {
  const unchanged: WidenOutcome = { changed: false, content: markdown };
  if (repos.length === 0) return unchanged;

  const lines = markdown.split("\n");
  const close = fenceEnd(lines);
  if (close === -1) return unchanged;

  const existing = declaredRepos(markdown);
  const merged = [...new Set([...existing, ...repos])].filter(Boolean).sort();
  if (merged.length === existing.length && merged.every((repo) => existing.includes(repo))) {
    return unchanged;
  }

  const value = merged.length === 1 ? merged[0]! : `[${merged.join(", ")}]`;
  const at = lines.slice(1, close).findIndex((line) => /^repo:\s*/.test(line));

  const next = [...lines];
  if (at === -1) {
    next.splice(close, 0, `repo: ${value}`);
  } else {
    next[at + 1] = `repo: ${value}`;
  }
  return { changed: true, content: next.join("\n") };
}
