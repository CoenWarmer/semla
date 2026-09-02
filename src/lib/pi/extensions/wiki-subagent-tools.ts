/**
 * Wiki tools for workflow subagents.
 *
 * A subagent's tool set is `createCodingTools(cwd)` — bash/read/edit/write —
 * plus whatever a named toolset adds. The wiki extension registers its tools on
 * the *host* session only, so a subagent never sees them. The model has no way
 * to know that: it sees `wiki_capture_source` in its own tool set and assumes a
 * subagent it spawns has it too.
 *
 * That assumption cost a real orient run 23 minutes and $8.90. Six subagents
 * were told to capture a facet each; all six reported the tool missing. Four
 * improvised through bash — one re-implemented capture by hand, another
 * imported the package's internal `captureText` and burned 3.19M input tokens
 * doing it — and two gave up, so their facets were never captured at all. The
 * hand-rolled captures also wrote manifests with no `file_path`, which is what
 * defeats pi-llm-wiki's own repo derivation (see wiki-repo-stamp.ts).
 *
 * Registering the tools as a named toolset closes the gap: a workflow that asks
 * for `toolset: "wiki"` gets the real tools, and the fan-out that was always
 * the point of an orient run actually works.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { stampRepoFrontmatter } from "./wiki-frontmatter";
import { withVaultLock } from "./wiki-vault-lock";

/** Toolset tag a workflow passes to reach these tools. */
export const WIKI_SUBAGENT_TOOLSET = "wiki";

/**
 * Toolset tag for one session's copy of the wiki tools.
 *
 * The tag has to be per session because the toolset map is process-wide and the
 * tools close over the repo of the session that built them. With a fixed "wiki"
 * key, the last session to load simply overwrote every earlier one, and three
 * concurrent orients attributed all 168 of their pages to a single repo.
 *
 * Falls back to the bare tag when no session id is available, which is what a
 * single-session process gets anyway.
 */
export function wikiToolsetKey(sessionId?: string): string {
  return sessionId ? `${WIKI_SUBAGENT_TOOLSET}:${sessionId}` : WIKI_SUBAGENT_TOOLSET;
}

/**
 * Wiki tools a subagent may hold, mapped to the package function that registers
 * each one. Read/append operations scoped to a single source or page: exactly
 * what a fan-out agent needs to do its share of the work.
 */
export const WIKI_SUBAGENT_REGISTRARS: Readonly<Record<string, string>> = {
  wiki_capture_source: "registerWikiCaptureSource",
  wiki_ensure_page: "registerWikiEnsurePage",
  wiki_search: "registerWikiSearch",
  wiki_status: "registerWikiStatus",
  wiki_log_event: "registerWikiLogEvent",
};

export const WIKI_SUBAGENT_TOOL_NAMES: readonly string[] = Object.keys(
  WIKI_SUBAGENT_REGISTRARS,
);

/**
 * Wiki tools deliberately withheld, and why. Kept as data rather than a comment
 * so the reasoning survives the next person who wonders where `wiki_ingest`
 * went, and so a test can assert the two sets never overlap.
 */
export const WIKI_TOOLS_WITHHELD_FROM_SUBAGENTS: Readonly<
  Record<string, string>
> = {
  wiki_ingest:
    "Starts a background synthesis workflow. A subagent calling it nests a run outside the parent's concurrency, budget and accounting — the same recursion that workflow/workflow_control are denied for.",
  wiki_reindex_embeddings:
    "The bridge turns this into its own workflow run, so it recurses for the same reason as wiki_ingest.",
  wiki_bootstrap:
    "Initialises the whole vault. Parallel subagents would race to create the same scaffold.",
  wiki_rebuild_meta:
    "Rewrites every derived file from every page. Concurrent rebuilds interleave and can publish a half-built registry.",
  wiki_watch:
    "Starts a long-lived watcher with no owner once the subagent that started it exits.",
};

const WIKI_TOOLS_MODULE = join(
  process.cwd(),
  ".pi/npm/node_modules/@zosmaai/pi-llm-wiki/dist/extensions/llm-wiki/lib/tools.js",
);

/**
 * Declared for wiki-package-contract.test.ts: the path is a computed string so
 * tsc cannot check it, and a release that renames a registrar would leave
 * subagents silently toolless again.
 */
export const WIKI_SUBAGENT_DEEP_IMPORTS: ReadonlyArray<{
  path: string;
  exports: readonly string[];
}> = [
  {
    path: WIKI_TOOLS_MODULE,
    exports: Object.values(WIKI_SUBAGENT_REGISTRARS),
  },
];

/**
 * Tools that write to the vault, and so must not run concurrently.
 *
 * The registrars are called without a Runtime — deliberately, since
 * pi-llm-wiki's Runtime launches its own background tasks, which the workflow
 * run owning the subagent neither tracks nor outlives. The cost is that
 * capture and ensure_page take their no-Runtime branch and call
 * rebuildMetadataLight synchronously: a full rebuild of every derived file,
 * per call, without scheduleReindex's single-flight coalescing. Six capture
 * agents in parallel would each rebuild the whole vault from a different
 * mid-flight snapshot and the last writer would win — the same race
 * wiki_rebuild_meta is withheld for.
 */
const VAULT_WRITING_TOOLS = new Set([
  "wiki_capture_source",
  "wiki_ensure_page",
  "wiki_log_event",
]);

/** Minimal shape this module needs from a registered tool. */
interface NamedTool {
  name: string;
}

interface ExecutableTool extends NamedTool {
  execute?: (...args: never[]) => unknown;
}

/**
 * Keep only the tools a subagent is allowed to hold.
 *
 * Separated from the collection below so the policy is testable without the
 * package installed — the filter, not the import, is the part with a decision
 * in it.
 */
export function selectSubagentTools<T extends NamedTool>(tools: T[]): T[] {
  const allowed = new Set(WIKI_SUBAGENT_TOOL_NAMES);
  const seen = new Set<string>();
  return tools.filter((tool) => {
    if (!allowed.has(tool.name) || seen.has(tool.name)) return false;
    seen.add(tool.name);
    return true;
  });
}

export interface VaultGuardOptions {
  wikiHome: string;
  /**
   * The repos of the session these tools belong to, resolved per call.
   *
   * Per call rather than captured once, so a source captured after the agent
   * has strayed into a second repository is tagged with both.
   */
  repoOf: () => string[];
}

/**
 * Reject a capture that names something the fetcher cannot fetch.
 *
 * `wiki_capture_source` takes url | file_path | text, and `url` is first in
 * both the schema and the description ("Capture a URL, local file, or pasted
 * text"). A subagent capturing local code and given no steer picks it, and the
 * package then runs the *web* extractor over whatever it was handed: an orient
 * run captured `/Users/coen/Dev/semla/README.md` as a URL and stored
 * "Content could not be extracted", and another fetched a GitHub 404 page —
 * both recorded as sources and both on their way into entity pages.
 *
 * Only obviously-unfetchable values are refused. A real http(s) URL still
 * works, because capturing a genuine web page is a legitimate use.
 */
export function rejectUnfetchableUrl(
  params: unknown,
): { content: Array<{ type: "text"; text: string }>; isError: true } | null {
  const fields = params as {
    url?: unknown;
    text?: unknown;
    file_path?: unknown;
    title?: unknown;
  } | null;
  const url = typeof fields?.url === "string" && fields.url.trim() !== "" ? fields.url : null;
  const titled = typeof fields?.title === "string" && fields.title.trim() !== "";
  const payload =
    typeof fields?.text === "string" && fields.text.trim() !== ""
      ? "text"
      : typeof fields?.file_path === "string" && fields.file_path.trim() !== ""
        ? "file_path"
        : null;

  const refusal = (text: string) => ({
    content: [{ type: "text" as const, text }],
    isError: true as const,
  });

  // First, because it is the one that loses work. The package tries url before
  // anything else and ignores the rest, so a url passed *beside* real content
  // throws that content away. One agent supplied
  // "https://example.com/placeholder-and-will-be-ignored" expecting the
  // opposite, and its facet was stored as the 167-byte example.com page.
  if (url && payload) {
    return refusal(
      `wiki_capture_source: \`url\` was passed alongside \`${payload}\`. ` +
        "The URL is fetched and the rest is discarded, so this would store " +
        `the page at "${url}" instead of your ${payload}. Omit \`url\` entirely ` +
        "— there is no placeholder value that gets ignored.",
    );
  }

  // An untitled local capture is filed under whatever the package can infer —
  // a temp filename, or "Pasted text — <date>". Three runs produced
  // "pi-bash-c72532dd1b9fc46a.log", "Pasted text — 2026-08-31" and
  // "semla_history.log", each holding exactly the right content under a name
  // nobody would ever search for. Telling the skill to pass a title did not
  // stop it, so the tool asks for one instead. A url capture is exempt: the
  // page carries a real title of its own.
  if (payload && !titled) {
    return refusal(
      `wiki_capture_source: a \`${payload}\` capture needs a \`title\`. ` +
        "Without one the page is filed under the temp filename or " +
        '"Pasted text", which makes it unfindable. Name it for what it ' +
        'holds — e.g. "semla History (150 commits, bodies)".',
    );
  }

  if (!url) return null;

  let scheme: string;
  try {
    scheme = new URL(url).protocol;
  } catch {
    scheme = "";
  }
  if (scheme === "http:" || scheme === "https:") return null;

  return refusal(
    `wiki_capture_source: "${url}" is not a fetchable URL. ` +
      "To capture a local file, read it and pass its contents as `text` " +
      "with a `title`, or pass the path as `file_path` — not as `url`.",
  );
}

const METADATA_MODULE = join(
  process.cwd(),
  ".pi/npm/node_modules/@zosmaai/pi-llm-wiki/dist/extensions/llm-wiki/lib/metadata.js",
);

/** Mirrors getVaultPaths in pi-llm-wiki utils.ts. */
const vaultPaths = (wikiHome: string) => ({
  root: wikiHome,
  raw: join(wikiHome, ".llm-wiki", "raw"),
  rawSources: join(wikiHome, ".llm-wiki", "raw", "sources"),
  rawTrajectories: join(wikiHome, ".llm-wiki", "raw", "trajectories"),
  wiki: join(wikiHome, ".llm-wiki", "wiki"),
  meta: join(wikiHome, ".llm-wiki", "meta"),
  dotWiki: join(wikiHome, ".llm-wiki"),
  outputs: join(wikiHome, ".llm-wiki", "outputs"),
  discoveries: join(wikiHome, ".llm-wiki", ".discoveries"),
});

/**
 * Rebuild the derived metadata after a capture.
 *
 * The capture tool is supposed to do this itself, but it only does so on one of
 * its two branches: with a Runtime it defers to a background reindex, and
 * without one it rebuilds inline. A run finished four captures with `meta/`
 * holding nothing but the event log — the pages were on disk and the registry
 * the browser reads did not exist, so the wiki reported itself uninitialised
 * while it was filling up. A later capture in the same run did write one, so
 * the skip is intermittent rather than a property of the vault: invoked
 * directly against that same vault the rebuild returns ok with no diagnostics.
 *
 * So this is not a workaround for a rebuild that fails, it is a guarantee that
 * one happens. Doing it here, under the lock the wrapper already holds, makes
 * the vault browsable as it fills rather than only after the first ingest.
 *
 * Captures that do not come through these wrapped copies — a main agent using
 * the extension's own tools — still depend on the background reindex.
 */
async function rebuildVaultMetadata(wikiHome: string): Promise<void> {
  // No package means no capture tool to wrap either, so this is not a fault
  // worth reporting — it is a vault being exercised without the wiki installed.
  if (!existsSync(METADATA_MODULE)) return;
  try {
    const meta = (await import(/* turbopackIgnore: true */ METADATA_MODULE)) as {
      rebuildMetadataLight: (paths: ReturnType<typeof vaultPaths>) => { ok?: boolean };
    };
    const result = meta.rebuildMetadataLight(vaultPaths(wikiHome));
    if (result && result.ok === false) {
      console.warn(
        "[wiki-bridge] metadata rebuild refused after capture; the vault will " +
          "look uninitialised until it succeeds.",
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[wiki-bridge] metadata rebuild failed after capture: ${message}`);
  }
}

const sourcePages = (wikiHome: string): string[] => {
  try {
    return readdirSync(join(wikiHome, ".llm-wiki", "wiki", "sources"));
  } catch {
    return [];
  }
};

/**
 * Attribute the source pages a capture just created.
 *
 * Called with the vault lock held, so "which files are new" is a real answer
 * rather than a guess — no other capture can be part-way through. Attributing
 * here rather than at turn end is what makes concurrent orients correct: a
 * source belongs to the session that captured it, not to whichever session's
 * turn happened to end first.
 */
/**
 * Apply the title the agent asked for to a page the package named itself.
 *
 * `captureFile` takes no title at all — tools.ts calls it with the path and
 * nothing else, and its manifest hardcodes `title: fileName`. So a file capture
 * is always filed under a basename: three runs produced
 * "pi-bash-c72532dd1b9fc46a.log", "semla_history.log" and one 116 KB commit
 * history nobody could find. Requiring a title from the agent does not help on
 * its own, because the package throws it away; it has to be put back here.
 *
 * Only ever renames a page this capture just created, and only when the current
 * title is the bare filename — a page the package titled sensibly is left alone.
 */
function applyCaptureTitle(
  wikiHome: string,
  before: Set<string>,
  filePath: string,
  title: string,
): void {
  const dir = join(wikiHome, ".llm-wiki", "wiki", "sources");
  const fileName = filePath.split("/").pop() ?? filePath;
  for (const entry of sourcePages(wikiHome)) {
    if (before.has(entry) || !entry.endsWith(".md")) continue;
    const path = join(dir, entry);
    try {
      const content = readFileSync(path, "utf8");
      if (!content.includes(`title: ${fileName}`)) continue;
      writeFileSync(
        path,
        content
          .replace(`title: ${fileName}`, `title: ${title}`)
          .replace(`# ${fileName}`, `# ${title}`),
        "utf8",
      );
      patchManifestTitle(wikiHome, entry.replace(/\.md$/, ""), title);
    } catch {
      // A page that cannot be renamed is still a correctly captured page.
    }
  }
}

/** Keep the packet's manifest agreeing with the page it produced. */
function patchManifestTitle(wikiHome: string, sourceId: string, title: string): void {
  const path = join(wikiHome, ".llm-wiki", "raw", "sources", sourceId, "manifest.json");
  try {
    const manifest = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    manifest.title = title;
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  } catch {
    // The page is what gets read; a stale manifest title is cosmetic.
  }
}

function attributeNewSources(
  wikiHome: string,
  before: Set<string>,
  repos: readonly string[],
): void {
  const dir = join(wikiHome, ".llm-wiki", "wiki", "sources");
  for (const entry of sourcePages(wikiHome)) {
    if (before.has(entry) || !entry.endsWith(".md")) continue;
    const path = join(dir, entry);
    try {
      const outcome = stampRepoFrontmatter(readFileSync(path, "utf8"), repos);
      if (outcome.changed) writeFileSync(path, outcome.content, "utf8");
    } catch {
      // The turn-end sweep still covers this page, just less precisely.
    }
  }
}

/**
 * Hold the vault lock across every write, and attribute captures as they land.
 *
 * Without a Runtime the package's capture and ensure_page tools rebuild every
 * derived file inline, and `nextSequentialId` allocates source ids by listing a
 * directory and adding one. Two sessions doing either at once lose data: the
 * later rebuild publishes a registry built before the other's pages existed,
 * and two captures can claim the same id, the second silently overwriting the
 * first. The lock is filesystem-based because the sessions it separates need
 * not share a process.
 */
/**
 * Replace a slash in a page title before the package turns it into a slug.
 *
 * `slugify` drops `/` rather than treating it as a separator, so a title
 * naming an owner and a repo fuses into one token: `elastic/kibana` became
 * `elastickibana` and `elastic/catalog-info` became `elasticcatalog-info`.
 * Normalising here rather than after the write is the only way to affect the
 * slug at all — the package derives it internally and never exposes it.
 */
export function normaliseTitleArgs<T>(args: readonly T[]): T[] {
  const params = args[1] as { title?: unknown } | null | undefined;
  const title = params && typeof params.title === "string" ? params.title : null;
  if (!title || !/[/\\]/.test(title)) return [...args];

  const next = [...args];
  next[1] = { ...params, title: title.replace(/[/\\]+/g, "-") } as unknown as T;
  return next;
}

export function guardVaultWrites<T extends ExecutableTool>(
  tools: T[],
  options: VaultGuardOptions,
): T[] {
  // A capture that lands with no repo is not fatal — the turn-end sweep still
  // attributes it — so this failed completely silently once already, when the
  // session→repo map was keyed on the wrong id and every lookup missed. Said
  // once per session, because the quiet fallback is exactly what hid it.
  let warnedNoRepo = false;

  return tools.map((tool) => {
    if (!VAULT_WRITING_TOOLS.has(tool.name) || typeof tool.execute !== "function") {
      return tool;
    }

    const execute = tool.execute.bind(tool);
    const isCapture = tool.name === "wiki_capture_source";

    return {
      ...tool,
      execute: (...rawArgs: never[]) => {
        // args are (toolCallId, params, signal, onUpdate, ctx).
        const args = normaliseTitleArgs(rawArgs) as never[];
        const refusal = isCapture ? rejectUnfetchableUrl(args[1]) : null;
        if (refusal) return Promise.resolve(refusal);

        return withVaultLock(options.wikiHome, tool.name, async () => {
          const before = isCapture ? new Set(sourcePages(options.wikiHome)) : null;
          const result = await execute(...args);
          const repos = options.repoOf();
          if (before) {
            const request = args[1] as { file_path?: unknown; title?: unknown } | null;
            const wanted = typeof request?.title === "string" ? request.title.trim() : "";
            if (wanted && typeof request?.file_path === "string" && request.file_path) {
              applyCaptureTitle(options.wikiHome, before, request.file_path, wanted);
            }
            await rebuildVaultMetadata(options.wikiHome);
          }
          if (before && repos.length > 0) {
            attributeNewSources(options.wikiHome, before, repos);
          } else if (before && !warnedNoRepo) {
            warnedNoRepo = true;
            console.warn(
              "[wiki-bridge] captured a source with no repo for this session. " +
                "Attribution falls back to the turn-end sweep, which is not safe " +
                "when two orients share a vault.",
            );
          }
          return result;
        });
      },
    };
  });
}

/**
 * Build the wiki tool definitions for subagents.
 *
 * The package's registrars only ever call `pi.registerTool`, so handing them a
 * proxy of the real ExtensionAPI that collects instead of registering yields
 * the genuine tool definitions — same parameters, same execute — without
 * touching the host session's tool set. Everything else falls through to the
 * real `pi`, which matters because capture-by-URL reaches back through it.
 */
export async function collectWikiSubagentTools<T extends ExecutableTool>(
  pi: object,
  guard: VaultGuardOptions,
): Promise<T[]> {
  const registrars = (await import(/* turbopackIgnore: true */ WIKI_TOOLS_MODULE)) as Record<
    string,
    ((collector: object) => void) | undefined
  >;

  const collected: T[] = [];
  const collector = {
    ...pi,
    registerTool: (tool: T) => {
      collected.push(tool);
    },
  };

  for (const registrar of Object.values(WIKI_SUBAGENT_REGISTRARS)) {
    registrars[registrar]?.(collector);
  }

  return guardVaultWrites(selectSubagentTools(collected), guard);
}
