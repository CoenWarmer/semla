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
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { WorkflowManager } from "./dynamic-workflows/src/workflow-manager.ts";

// WIKI_HOME: read from env (set by runtime-config.ts before any session starts).
// Cannot import from "@/lib/pi/runtime-config" here because the "@/" alias is a
// Next.js convention that jiti (the pi extension loader) does not resolve.
const WIKI_HOME = process.env.WIKI_HOME ?? join(process.cwd(), ".semla-wiki");

// ── Global symbol keys (shared with workflow.ts and pi-llm-wiki) ──────────────

const DISPATCHER_KEY = Symbol.for("semla.wiki-ingest-dispatcher");
const REINDEX_DISPATCHER_KEY = Symbol.for("semla.wiki-reindex-dispatcher");
const EXTRA_TOOLSETS_KEY = Symbol.for("semla.workflow.extra-toolsets");
const ACTIVE_MANAGER_KEY = Symbol.for("semla.active-workflow-manager");
const BRIDGE_RUN_STARTED_KEY = Symbol.for("semla.bridge-run-started");

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

// ── Dispatcher types ───────────────────────────────────────────────────────────

type IngestSource = {
  id: string;
  extracted: string;
  manifest: Record<string, unknown>;
};

export type WikiIngestDispatcher = (sources: IngestSource[]) => boolean;

// ── Per-run toolset key counter (avoids Date.now() collisions) ───────────────

let runCounter = 0;
function nextRunKey(prefix: string): string {
  return `${prefix}:${++runCounter}`;
}

// ── Bridge notifier type (shared with session-service.ts) ─────────────────────

export type BridgeRunNotifier = (runId: string, opts?: { primary?: boolean }) => void;

// ── Extension entry point ──────────────────────────────────────────────────────

// pi is required by the extension contract even though this bridge doesn't
// register any tools or event handlers on it.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export default function wikiIngestBridge(_pi: ExtensionAPI) {
  const dispatcher: WikiIngestDispatcher = (sources) => {
    const manager = (globalThis as Record<symbol, unknown>)[ACTIVE_MANAGER_KEY] as
      | WorkflowManager
      | undefined;
    if (!manager) return false;

    const extraToolsets = ((globalThis as Record<symbol, unknown>)[EXTRA_TOOLSETS_KEY] ??=
      {}) as Record<string, () => ReturnType<typeof createBatchCommitSynthesisTool>[]>;

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

    const notifier = (globalThis as Record<symbol, unknown>)[BRIDGE_RUN_STARTED_KEY] as
      | BridgeRunNotifier
      | undefined;
    notifier?.(runId, { primary: true });

    return true;
  };

  (globalThis as Record<symbol, unknown>)[DISPATCHER_KEY] = dispatcher;

  type ReindexArgs = { paths: WikiVaultPaths; embedder: WikiEmbedder; force: boolean };
  const reindexDispatcher = ({ paths, embedder, force }: ReindexArgs): boolean => {
    const manager = (globalThis as Record<symbol, unknown>)[ACTIVE_MANAGER_KEY] as
      | WorkflowManager
      | undefined;
    if (!manager) return false;

    const extraToolsets = ((globalThis as Record<symbol, unknown>)[EXTRA_TOOLSETS_KEY] ??=
      {}) as Record<string, () => ReturnType<typeof createRunReindexTool>[]>;

    const toolsetKey = nextRunKey("wiki-reindex");
    extraToolsets[toolsetKey] = () => [createRunReindexTool(embedder, paths, force)];

    // Reindex is still fire-and-forget: embedding completion doesn't need a
    // report turn; the agent checks wiki_status if it wants confirmation.
    const { runId: reindexRunId } = manager.startInBackground(
      WIKI_REINDEX_SCRIPT,
      { model: embedder.model },
      { toolset: toolsetKey, suppressDelivery: true },
    );
    const notifier = (globalThis as Record<symbol, unknown>)[BRIDGE_RUN_STARTED_KEY] as
      | BridgeRunNotifier
      | undefined;
    notifier?.(reindexRunId);
    return true;
  };

  (globalThis as Record<symbol, unknown>)[REINDEX_DISPATCHER_KEY] = reindexDispatcher;
}
