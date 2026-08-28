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

import { join } from "node:path";

/** Toolset tag a workflow passes to reach these tools. */
export const WIKI_SUBAGENT_TOOLSET = "wiki";

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
  ".pi/npm/node_modules/@zosmaai/pi-llm-wiki/extensions/llm-wiki/lib/tools.ts",
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
 * Run the vault writers one at a time.
 *
 * Only the write takes its turn — agents still read, reason and summarise
 * concurrently, which is where a fan-out's time actually goes. A rejected call
 * must not poison the queue, so the chain absorbs failures.
 */
export function serializeVaultWrites<T extends ExecutableTool>(tools: T[]): T[] {
  let queue: Promise<unknown> = Promise.resolve();

  return tools.map((tool) => {
    if (!VAULT_WRITING_TOOLS.has(tool.name) || typeof tool.execute !== "function") {
      return tool;
    }

    const execute = tool.execute.bind(tool);
    return {
      ...tool,
      execute: (...args: never[]) => {
        const result = queue.then(() => execute(...args));
        queue = result.then(
          () => undefined,
          () => undefined,
        );
        return result;
      },
    };
  });
}

/**
 * Keep only the tools a subagent is allowed to hold.
 *
 * Separated from the collection above so the policy is testable without the
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
): Promise<T[]> {
  const registrars = (await import(WIKI_TOOLS_MODULE)) as Record<
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

  return serializeVaultWrites(selectSubagentTools(collected));
}
