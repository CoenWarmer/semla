/**
 * Wiki background-task bridge: intercepts pi-llm-wiki background operations
 * and runs them as Semla dynamic workflows so they appear in the trace waterfall.
 *
 * Covered operations:
 * - wiki_ingest synthesis: one coordinator workflow per batch, fanning out all
 *   sources as parallel subagents — a single delivery signals completion.
 * - wiki_reindex_embeddings: one workflow run, "Embed" phase with run_reindex tool
 *
 * How it works:
 * 1. Registers global dispatcher symbols that pi-llm-wiki's tools.ts checks.
 * 2. The ingest dispatcher starts ONE coordinating workflow per batch, using
 *    parallel() to fan out all sources. A shared commit_synthesis tool (with a
 *    source_id param) is registered in the batch toolset so each parallel
 *    subagent can commit its own source.
 * 3. The coordinator is marked as "primary" so session-service arms a proper
 *    background continuation — the agent is notified once when the batch is done,
 *    rather than once per source.
 * 4. workflow.ts's toolset Proxy reads extra toolsets from globalThis at
 *    lookup time so late-registered toolsets are visible without a rebuild.
 */

import { join } from "node:path";
import {
  createCodingTools,
  defineTool,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  ACTIVE_WORKFLOW_MANAGER,
  BRIDGE_RUN_STARTED,
  readOrInitSlot,
  readSlot,
  WIKI_INGEST_DISPATCHER,
  WIKI_REINDEX_DISPATCHER,
  WORKFLOW_EXTRA_TOOLSETS,
  writeSlot,
  type WikiIngestDispatcher,
  type WikiReindexDispatcher,
} from "../extension-contract.js";
import {
  collectWikiSubagentTools,
  WIKI_SUBAGENT_TOOLSET,
} from "./wiki-subagent-tools.js";

// WIKI_HOME: read from env (set by runtime-config.ts before any session starts).
// Cannot import from "@/lib/pi/runtime-config" here because the "@/" alias is a
// Next.js convention that jiti (the pi extension loader) does not resolve.
const WIKI_HOME = process.env.WIKI_HOME ?? join(process.cwd(), ".semla-wiki");


// ── Types replicated from pi-llm-wiki (avoids importing outside tsconfig) ─────

interface WikiEmbedder {
  model: string;
  embed: unknown;
}

interface ReindexStats {
  embedded: number;
  skipped: number;
  pruned: number;
}

interface WikiVaultPaths {
  root: string;
  raw: string;
  rawSources: string;
  rawTrajectories: string;
  wiki: string;
  meta: string;
  dotWiki: string;
  outputs: string;
  discoveries: string;
}

interface CommitResult {
  sourceId: string;
  entitiesCreated: string[];
  conceptsCreated: string[];
  contradictions: number;
}

type CommitOutcome =
  | ({ ok: true } & CommitResult)
  | { ok: false; sourceId: string; diagnostics: Array<{ message: string }> };

type CommitSynthesisData = {
  summary: string;
  key_takeaways: string[];
  entities: Array<{ title: string; description: string }>;
  concepts: Array<{ title: string; definition: string }>;
  quotes?: Array<{ text: string; attribution?: string }>;
  contradictions?: string[];
};

type CommitFn = (
  paths: WikiVaultPaths,
  sourceId: string,
  manifest: Record<string, unknown>,
  data: CommitSynthesisData,
) => CommitOutcome;

type RebuildFn = (paths: WikiVaultPaths) => void;

// ── Schema ────────────────────────────────────────────────────────────────────
// Batch version adds source_id so the shared tool knows which source to commit.

const BatchCommitSynthesisParams = Type.Object({
  source_id: Type.String({
    description: "The sourceId of the source being synthesized (e.g. SRC-2026-08-28-001).",
  }),
  summary: Type.String({ minLength: 1, description: "2-3 paragraph summary." }),
  key_takeaways: Type.Array(Type.String({ minLength: 1 }), {
    description: "The most important points.",
  }),
  entities: Type.Array(
    Type.Object({
      title: Type.String({ minLength: 1 }),
      description: Type.String(),
    }),
    { description: "Named entities mentioned in the source." },
  ),
  concepts: Type.Array(
    Type.Object({
      title: Type.String({ minLength: 1 }),
      definition: Type.String(),
    }),
    { description: "Concepts discussed in the source." },
  ),
  quotes: Type.Optional(
    Type.Array(
      Type.Object({
        text: Type.String({ minLength: 1 }),
        attribution: Type.Optional(Type.String()),
      }),
    ),
  ),
  contradictions: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
});

// ── Vault paths (mirrors getVaultPaths in pi-llm-wiki utils.ts) ───────────────

function buildVaultPaths(): WikiVaultPaths {
  const root = WIKI_HOME;
  return {
    root,
    raw: join(root, ".llm-wiki", "raw"),
    rawSources: join(root, ".llm-wiki", "raw", "sources"),
    rawTrajectories: join(root, ".llm-wiki", "raw", "trajectories"),
    wiki: join(root, ".llm-wiki", "wiki"),
    meta: join(root, ".llm-wiki", "meta"),
    dotWiki: join(root, ".llm-wiki"),
    outputs: join(root, ".llm-wiki", "outputs"),
    discoveries: join(root, ".llm-wiki", ".discoveries"),
  };
}

// ── Dynamic import for pi-llm-wiki runtime functions ─────────────────────────
// Paths are computed strings so tsc does not attempt to resolve them as modules.

const INGEST_WORKER_PATH = join(
  process.cwd(),
  ".pi/npm/node_modules/@zosmaai/pi-llm-wiki/extensions/llm-wiki/lib/ingest-worker.ts",
);
const METADATA_PATH = join(
  process.cwd(),
  ".pi/npm/node_modules/@zosmaai/pi-llm-wiki/extensions/llm-wiki/lib/metadata.ts",
);
const EMBEDDINGS_PATH = join(
  process.cwd(),
  ".pi/npm/node_modules/@zosmaai/pi-llm-wiki/extensions/llm-wiki/lib/embeddings.ts",
);

/**
 * The deep imports above are computed strings, so tsc cannot check them and a
 * pi-llm-wiki release that moves a file or renames a function breaks synthesis
 * at runtime with no build-time signal. Declaring what each module owes lets
 * wiki-package-contract.test.ts restore that signal.
 */
export const WIKI_PACKAGE_DEEP_IMPORTS: ReadonlyArray<{
  path: string;
  exports: readonly string[];
}> = [
  { path: INGEST_WORKER_PATH, exports: ["commitSynthesis"] },
  { path: METADATA_PATH, exports: ["appendEvent", "rebuildMetadataLight"] },
  { path: EMBEDDINGS_PATH, exports: ["reindexEmbeddings"] },
];

// ── Run-reindex tool factory ──────────────────────────────────────────────────

type AppendEventFn = (
  paths: WikiVaultPaths,
  event: { kind: string; embedded: number; skipped: number; pruned: number; model: string },
) => void;

function createRunReindexTool(embedder: WikiEmbedder, paths: WikiVaultPaths, force: boolean) {
  return defineTool({
    name: "run_reindex",
    label: "Run Embedding Reindex",
    description:
      "Embed all stale registered wiki pages and prune deleted entries. Call exactly once.",
    promptSnippet: "Run the embedding reindex",
    parameters: Type.Object({}),
    async execute() {
      const embeddings = (await import(EMBEDDINGS_PATH)) as {
        reindexEmbeddings: (
          paths: WikiVaultPaths,
          embedder: WikiEmbedder,
          opts: { force?: boolean },
        ) => Promise<ReindexStats>;
      };
      const meta = (await import(METADATA_PATH)) as { appendEvent: AppendEventFn };

      const stats = await embeddings.reindexEmbeddings(paths, embedder, { force });

      meta.appendEvent(paths, {
        kind: "reindex_embeddings",
        embedded: stats.embedded,
        skipped: stats.skipped,
        pruned: stats.pruned,
        model: embedder.model,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: `Embeddings reindexed (${embedder.model}): ${stats.embedded} embedded, ${stats.skipped} fresh, ${stats.pruned} pruned. Reply with a one-line confirmation and stop.`,
          },
        ],
        details: { ...stats, model: embedder.model } as Record<string, unknown>,
      };
    },
  });
}

// ── Reindex workflow script ───────────────────────────────────────────────────

const WIKI_REINDEX_SCRIPT = `
export const meta = {
  name: "wiki-reindex",
  description: "Embed all stale wiki pages and prune deleted entries",
  phases: [{ title: "Embed" }],
};

await agent(
  \`You are the LLM Wiki embedding agent. Run the embedding reindex by calling run_reindex exactly once, then confirm with one line.

Model: \${args.model}\`,
  { label: \`Reindex embeddings: \${args.model}\`, phase: "Embed" }
);
`;

// ── Batch commit-synthesis tool factory ───────────────────────────────────────
// One shared tool per batch; source_id param routes each call to the right manifest.

function createBatchCommitSynthesisTool(
  manifests: Map<string, Record<string, unknown>>,
  paths: WikiVaultPaths,
) {
  return defineTool({
    name: "commit_synthesis",
    label: "Commit Synthesis",
    description:
      "Persist the structured synthesis of one source into wiki pages. Call exactly once per source, passing the correct source_id.",
    promptSnippet: "Commit synthesis to the wiki",
    parameters: BatchCommitSynthesisParams,
    async execute(_id, params) {
      const { source_id, ...synthesisData } = params as { source_id: string } & CommitSynthesisData;

      const manifest = manifests.get(source_id);
      if (!manifest) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Unknown source_id "${source_id}". Valid IDs: ${[...manifests.keys()].join(", ")}`,
            },
          ],
          details: { source_id } as Record<string, unknown>,
          isError: true,
        };
      }

      const worker = (await import(INGEST_WORKER_PATH)) as { commitSynthesis: CommitFn };
      const meta = (await import(METADATA_PATH)) as { rebuildMetadataLight: RebuildFn };

      const outcome = worker.commitSynthesis(
        paths,
        source_id,
        manifest,
        synthesisData as unknown as CommitSynthesisData,
      );

      if (!outcome.ok) {
        return {
          content: [
            { type: "text" as const, text: `Failed: ${outcome.diagnostics[0].message}` },
          ],
          details: { source_id } as Record<string, unknown>,
          isError: true,
        };
      }

      meta.rebuildMetadataLight(paths);

      const ack = [
        `Committed: source page`,
        outcome.entitiesCreated.length > 0
          ? `+ ${outcome.entitiesCreated.length} new entit${outcome.entitiesCreated.length === 1 ? "y" : "ies"}`
          : null,
        outcome.conceptsCreated.length > 0
          ? `+ ${outcome.conceptsCreated.length} new concept${outcome.conceptsCreated.length === 1 ? "" : "s"}`
          : null,
      ]
        .filter(Boolean)
        .join(" ");

      return {
        content: [
          {
            type: "text" as const,
            text: `${ack}. Reply with a one-line confirmation and stop.`,
          },
        ],
        details: { ...outcome } as Record<string, unknown>,
      };
    },
  });
}

// ── Batch ingest workflow script ──────────────────────────────────────────────
// One coordinator per wiki_ingest call; sources fan out as parallel subagents.

const WIKI_INGEST_BATCH_SCRIPT = `
export const meta = {
  name: "wiki-ingest",
  description: "Synthesize captured wiki sources into structured knowledge",
  phases: [{ title: "Synthesize" }],
};

await parallel(args.sources.map((source) => () =>
  agent(
    \`You are the LLM Wiki ingestion synthesizer. Synthesize this captured source by calling commit_synthesis exactly once.

SOURCE: \${source.title} (\${source.sourceId})

EXTRACTED CONTENT:
\${source.extractedContent}

Rules:
- Never fabricate. Only include entities/concepts present in the source.
- Keep descriptions to one line.
- Call commit_synthesis with source_id="\${source.sourceId}" and your synthesis.
- After calling commit_synthesis once, reply with a one-line confirmation and stop.\`,
    { label: \`Synthesize: \${source.title}\`, phase: "Synthesize" }
  )
));
`;

// ── Per-run toolset key counter (avoids Date.now() collisions) ───────────────

let runCounter = 0;
function nextRunKey(prefix: string): string {
  return `${prefix}:${++runCounter}`;
}

// ── Extension entry point ──────────────────────────────────────────────────────

/**
 * Publish the wiki toolset so workflow subagents can reach the real wiki tools.
 *
 * Collection is async (the package is loaded through a computed path) but the
 * manager resolves a toolset synchronously, so the tools are gathered once at
 * extension load and the closure serves the cached array. A workflow cannot run
 * before the extension set finishes loading, so the cache is always warm by the
 * time anything reads it; if collection failed, the tag resolves to the plain
 * coding tools — exactly the behaviour before this existed.
 */
function registerSubagentWikiToolset(pi: ExtensionAPI): void {
  let wikiTools: Array<ReturnType<typeof defineTool>> = [];

  void collectWikiSubagentTools<ReturnType<typeof defineTool>>(pi)
    .then((tools) => {
      wikiTools = tools;
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `[wiki-bridge] wiki subagent toolset unavailable: ${message}. ` +
          "Workflow subagents will fall back to coding tools only.",
      );
    });

  const extraToolsets = readOrInitSlot(WORKFLOW_EXTRA_TOOLSETS, () => ({}));
  // A named toolset replaces the default tool set rather than adding to it, so
  // the coding tools have to be repeated here — see the "web-research" entry in
  // workflow.ts, which does the same.
  extraToolsets[WIKI_SUBAGENT_TOOLSET] = () => [
    ...createCodingTools(process.cwd()),
    ...wikiTools,
  ];
}

export default function wikiIngestBridge(pi: ExtensionAPI) {
  registerSubagentWikiToolset(pi);

  const dispatcher: WikiIngestDispatcher = (sources) => {
    const manager = readSlot(ACTIVE_WORKFLOW_MANAGER);
    if (!manager) return false;

    const extraToolsets = readOrInitSlot(WORKFLOW_EXTRA_TOOLSETS, () => ({}));

    const paths = buildVaultPaths();
    const manifests = new Map(sources.map((s) => [s.id, s.manifest]));
    const toolsetKey = nextRunKey("wiki-synthesis");

    // Single shared commit_synthesis tool — source_id param routes each call.
    extraToolsets[toolsetKey] = () => [createBatchCommitSynthesisTool(manifests, paths)];

    const { runId } = manager.startInBackground(
      WIKI_INGEST_BATCH_SCRIPT,
      {
        sources: sources.map((s) => ({
          sourceId: s.id,
          title: String(s.manifest.title ?? s.id),
          extractedContent: s.extracted.slice(0, 24_000),
        })),
      },
      { toolset: toolsetKey },
    );

    readSlot(BRIDGE_RUN_STARTED)?.(runId, { primary: true });

    return true;
  };

  writeSlot(WIKI_INGEST_DISPATCHER, dispatcher);

  const reindexDispatcher: WikiReindexDispatcher = (args) => {
    // pi-llm-wiki types these as `unknown` at the contract boundary; they are
    // the vault paths and embedder it just built for this call.
    const paths = args.paths as WikiVaultPaths;
    const embedder = args.embedder as WikiEmbedder;
    const force = args.force;

    const manager = readSlot(ACTIVE_WORKFLOW_MANAGER);
    if (!manager) return false;

    const extraToolsets = readOrInitSlot(WORKFLOW_EXTRA_TOOLSETS, () => ({}));

    const toolsetKey = nextRunKey("wiki-reindex");
    extraToolsets[toolsetKey] = () => [createRunReindexTool(embedder, paths, force)];

    // Reindex is still fire-and-forget: embedding completion doesn't need a
    // report turn; the agent checks wiki_status if it wants confirmation.
    const { runId: reindexRunId } = manager.startInBackground(
      WIKI_REINDEX_SCRIPT,
      { model: embedder.model },
      { toolset: toolsetKey, suppressDelivery: true },
    );
    readSlot(BRIDGE_RUN_STARTED)?.(reindexRunId);
    return true;
  };

  writeSlot(WIKI_REINDEX_DISPATCHER, reindexDispatcher);
}
