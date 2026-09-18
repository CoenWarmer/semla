/**
 * What a session did with the wiki: pages offered to it, pages it opened, and
 * pages it wrote.
 *
 * Three questions that look alike and are not, which is the whole reason this
 * module names them separately:
 *
 *  - **recalled** — pages pi-llm-wiki's `before_agent_start` hook injected
 *    into the model's context, whether or not the agent did anything with
 *    them. Parsed out of `SessionMessage.wikiRecall` (see
 *    wiki-recall-message.ts). Measured over 441 real injections, 91.4% were
 *    inert, so this number is *offered*, never *used* — presenting it as the
 *    latter would be the same overclaim wiki-recall-filter.ts documents.
 *  - **read** — pages the agent chose to open, recovered from `read` tool
 *    calls whose path lands inside the vault. This is the one signal that
 *    shows the recall injection actually paid off.
 *  - **written** — pages and observations the session produced, from the
 *    `wiki_*` tool calls that create them.
 *
 * Derived from the transcript rather than recorded at the source. That is a
 * deliberate trade and it has a real limit: a workflow subagent's wiki calls
 * never reach the host transcript (the same blind spot spec-attribution.ts
 * documents for artifacts), so a session whose wiki work happened inside a
 * workflow reports less than it did. The alternative — a new per-tool-call
 * record — would be authoritative, but nothing in the vault or the artifact
 * store carries a session id today, so it would be new plumbing on the write
 * path for a read-side summary. Derivation was verified against 311 real
 * transcripts in `.semla-sessions/`: 4,709 vault-path reads and 259
 * page-creating calls, so the signal is present and strong in practice.
 *
 * Pure and client-safe on purpose: the session page already holds `messages`
 * and `toolCalls` for its transcript, so the card computes this from data
 * that is already on the client instead of asking a route to re-read the
 * same transcript on every poll.
 */

/** A wiki page a session touched. */
export interface WikiPageRef {
  /**
   * Vault-relative id — `concepts/single-user-mode`. The identity: the same
   * page reached by a recall link and by a `read` of its absolute path must
   * dedupe to one entry, and only the folder-and-slug pair is common to both.
   */
  id: string;
  /** Folder it lives in: `concepts`, `entities`, `sources`, … */
  folder: string;
  /** Human label — the page's title where one was available, else its slug. */
  label: string;
}

export interface WikiActivity {
  /** Pages auto-recall put in front of the model, newest turn first. */
  recalled: WikiPageRef[];
  /** Pages the agent opened. */
  read: WikiPageRef[];
  /** Pages and observations the session created. */
  written: WikiPageRef[];
}

export const NO_WIKI_ACTIVITY: WikiActivity = {
  read: [],
  recalled: [],
  written: [],
};

/**
 * The tool calls that bring a wiki page into existence.
 *
 * `wiki_capture_source` is deliberately absent even though it does create a
 * source page: it is the *input* half of the pipeline (a URL or file handed
 * in), and counting it as something the session produced would inflate a
 * capture-heavy orient run into looking like it authored a hundred pages.
 * `wiki_ingest`, `wiki_lint` and `wiki_rebuild_meta` are absent for a
 * sharper reason — they run in the background and their pages are written by
 * a worker, so the host transcript cannot say what they produced.
 */
const WRITING_TOOLS = new Set(["wiki_ensure_page", "wiki_observe", "wiki_retro"]);

/** Folders the vault keeps pages in. Anything else is not a page. */
const PAGE_FOLDERS = new Set([
  "analyses",
  "cases",
  "concepts",
  "entities",
  "requirements",
  "skills",
  "sources",
  "syntheses",
]);

/** `concepts/foo` out of any path that runs through a vault's wiki directory. */
export function pageIdFromPath(path: string): string | null {
  const normalized = path.replaceAll("\\", "/");
  // The vault directory name is the anchor rather than the absolute prefix:
  // PI_WORKSPACE_ROOT differs per machine, and a transcript recorded on one
  // is read on another.
  const match = /(?:^|\/)\.llm-wiki\/wiki\/([^/]+)\/(.+?)(?:\.mdx?)?$/.exec(normalized);
  if (!match) return null;

  const [, folder, slug] = match;
  if (!PAGE_FOLDERS.has(folder) || slug === "") return null;
  // A nested path is not a page — only `<folder>/<slug>` is.
  if (slug.includes("/")) return null;

  return `${folder}/${slug}`;
}

/** Page ref from a vault-relative id, with no better label than the slug. */
function refFromId(id: string, label?: string): WikiPageRef | null {
  const slash = id.indexOf("/");
  if (slash <= 0 || slash === id.length - 1) return null;

  const folder = id.slice(0, slash);
  const slug = id.slice(slash + 1);
  return { folder, id, label: label?.trim() ? label.trim() : slug };
}

/**
 * Page ids and titles out of one recall injection.
 *
 * The injected block is Markdown built for a model to read, so this parses a
 * presentation format and is tolerant by design — a recall whose wording
 * changes should cost the *labels*, not throw inside a render. Each hit is a
 * numbered line shaped:
 *
 *     1. **[[concepts/slug]]** — *concept* — score 48.4 — Title — #Title — …
 *
 * The `[[...]]` target is the id (path-based wikilinks are mandatory in this
 * vault, so it is always `folder/slug`); the segment after the score is the
 * page's own title, which is a far better chip label than the slug.
 */
export function parseRecalledPages(content: string): WikiPageRef[] {
  const refs: WikiPageRef[] = [];

  for (const line of content.split("\n")) {
    const link = /\[\[([^\]]+)\]\]/.exec(line);
    if (!link) continue;

    // Fourth em-dash-separated field, when present: `score N — Title —`.
    const title = /—\s*score\s+[\d.]+\s*—\s*([^—]+?)\s*—/.exec(line)?.[1];
    const ref = refFromId(link[1].trim(), title);
    if (ref) refs.push(ref);
  }

  return refs;
}

/**
 * The slug `wiki_ensure_page`/`wiki_retro`/`wiki_observe` would file a page
 * under, from the arguments the transcript kept.
 *
 * `wiki_retro` takes an explicit `slug`; the other two derive one from the
 * title. Mirrors the package's own kebab-casing closely enough for an
 * identity — this is a display summary, and a slug that disagrees in some
 * edge case shows a slightly different label, it does not break a link. The
 * folder is the weaker guess: `wiki_ensure_page` takes a free-form `type`
 * that the package maps to a folder, and anything it does not recognise
 * falls back to `concepts/` (which is why `type: person` pages live there).
 */
function writtenPageRef(
  name: string,
  params: Record<string, string> | undefined,
): WikiPageRef | null {
  if (!params) return null;

  const title = params.title?.trim();
  const slug =
    params.slug?.trim() ||
    title
      ?.toLowerCase()
      .replaceAll(/[^a-z0-9]+/g, "-")
      .replaceAll(/^-+|-+$/g, "");
  if (!slug) return null;

  // An observation and a retro are both filed as sources; a page's folder
  // comes from its `type`, with concepts as the package's own fallback.
  const folder =
    name === "wiki_ensure_page" ? folderForPageType(params.type) : "sources";

  return { folder, id: `${folder}/${slug}`, label: title ?? slug };
}

/**
 * Folder for a `wiki_ensure_page` type.
 *
 * Only the types the package maps to a folder of their own are listed;
 * everything else — `person`, `organisation`, and any type a caller invents
 * — lands in `concepts/`, which is the package's documented fallback rather
 * than a guess made here.
 */
function folderForPageType(type: string | undefined): string {
  switch (type?.trim()) {
    case "entity":
      return "entities";
    case "analysis":
      return "analyses";
    case "synthesis":
      return "syntheses";
    case "requirement":
      return "requirements";
    case "skill":
      return "skills";
    case "case":
      return "cases";
    default:
      return "concepts";
  }
}

/** Dedupe by page id, keeping first-seen order and the best label seen. */
function dedupe(refs: readonly WikiPageRef[]): WikiPageRef[] {
  const byId = new Map<string, WikiPageRef>();

  for (const ref of refs) {
    const existing = byId.get(ref.id);
    if (!existing) {
      byId.set(ref.id, ref);
      continue;
    }
    // A later sighting with a real title beats an earlier slug-only one: the
    // same page can arrive from a `read` (path, so slug only) and from a
    // recall line (which carries its title).
    if (existing.label === ref.id.slice(ref.id.indexOf("/") + 1) && ref.label !== existing.label) {
      byId.set(ref.id, ref);
    }
  }

  return [...byId.values()];
}

/**
 * What this session did with the wiki.
 *
 * Newest first throughout, matching every other chip row in the app. Both
 * inputs are what the session page already has in hand.
 */
export function deriveWikiActivity({
  messages,
  toolCalls,
}: {
  messages: readonly { createdAt: string; wikiRecall?: string }[];
  toolCalls: readonly {
    createdAt: string;
    isError?: boolean;
    name: string;
    params?: Record<string, string>;
  }[];
}): WikiActivity {
  const recalled: WikiPageRef[] = [];
  // Newest turn first, so a long session's most recent context leads.
  for (const message of [...messages].reverse()) {
    if (message.wikiRecall) recalled.push(...parseRecalledPages(message.wikiRecall));
  }

  const read: WikiPageRef[] = [];
  const written: WikiPageRef[] = [];

  for (const call of [...toolCalls].reverse()) {
    // A failed call neither opened nor created anything. Counting it would
    // report work that did not happen, which is the one thing a traceability
    // summary must not do.
    if (call.isError) continue;

    if (call.name === "read") {
      const id = call.params?.path ? pageIdFromPath(call.params.path) : null;
      const ref = id ? refFromId(id) : null;
      if (ref) read.push(ref);
      continue;
    }

    if (WRITING_TOOLS.has(call.name)) {
      const ref = writtenPageRef(call.name, call.params);
      if (ref) written.push(ref);
    }
  }

  return {
    read: dedupe(read),
    recalled: dedupe(recalled),
    written: dedupe(written),
  };
}

/** Whether there is any wiki story to tell. */
export const hasWikiActivity = (activity: WikiActivity): boolean =>
  activity.recalled.length > 0 ||
  activity.read.length > 0 ||
  activity.written.length > 0;
