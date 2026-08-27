/**
 * Wiki ingest bridge: intercepts wiki_ingest background synthesis and runs it
 * as Semla dynamic workflows so each source appears in the trace waterfall.
 *
 * How it works:
 * 1. Registers Symbol.for("semla.wiki-ingest-dispatcher") in globalThis.
 * 2. pi-llm-wiki's tools.ts checks for this symbol before its own launchTask.
 * 3. When called, the dispatcher launches one WorkflowManager.startInBackground()
 *    run per source, each with a per-source "wiki-synthesis:<id>" toolset that
 *    includes a commit_synthesis tool backed by pi-llm-wiki's commitSynthesis().
 * 4. workflow.ts's toolset Proxy reads the per-source toolsets from
 *    Symbol.for("semla.workflow.extra-toolsets") at run time.
 */

import { join } from "node:path";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { WIKI_HOME } from "@/lib/pi/runtime-config";
import type { WorkflowManager } from "./dynamic-workflows/src/workflow-manager.ts";

// ── Global symbol keys (shared with workflow.ts and pi-llm-wiki) ──────────────

const DISPATCHER_KEY = Symbol.for("semla.wiki-ingest-dispatcher");
const EXTRA_TOOLSETS_KEY = Symbol.for("semla.workflow.extra-toolsets");
const ACTIVE_MANAGER_KEY = Symbol.for("semla.active-workflow-manager");

// ── Types replicated from pi-llm-wiki (avoids importing outside tsconfig) ─────

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

// ── Schema (mirrors CommitSynthesisSchema in pi-llm-wiki ingest-worker.ts) ────

const CommitSynthesisParams = Type.Object({
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

// ── Commit synthesis tool factory ─────────────────────────────────────────────

function createCommitSynthesisTool(
  sourceId: string,
  manifest: Record<string, unknown>,
  paths: WikiVaultPaths,
) {
  return defineTool({
    name: "commit_synthesis",
    label: "Commit Synthesis",
    description:
      "Persist the structured synthesis of this source into wiki pages. Call exactly once.",
    promptSnippet: "Commit synthesis to the wiki",
    parameters: CommitSynthesisParams,
    async execute(_id, params) {
      // Dynamic import at call time — path is a string variable so tsc skips
      // module resolution, and jiti (the extension loader) resolves .ts files.
      const worker = (await import(INGEST_WORKER_PATH)) as { commitSynthesis: CommitFn };
      const meta = (await import(METADATA_PATH)) as { rebuildMetadataLight: RebuildFn };

      const outcome = worker.commitSynthesis(
        paths,
        sourceId,
        manifest,
        params as unknown as CommitSynthesisData,
      );

      if (!outcome.ok) {
        return {
          content: [
            { type: "text" as const, text: `Failed: ${outcome.diagnostics[0].message}` },
          ],
          details: { sourceId } as Record<string, unknown>,
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

// ── Workflow script ────────────────────────────────────────────────────────────

const WIKI_INGEST_SCRIPT = `
export const meta = {
  name: "wiki-ingest",
  description: "Synthesize a captured wiki source into structured knowledge",
  phases: [{ title: "Synthesize" }],
};

await agent(
  \`You are the LLM Wiki ingestion synthesizer. Synthesize this captured source by calling commit_synthesis exactly once.

SOURCE: \${args.title} (\${args.sourceId})

EXTRACTED CONTENT:
\${args.extractedContent}

Rules:
- Never fabricate. Only include entities/concepts present in the source.
- Keep descriptions to one line.
- After calling commit_synthesis once, reply with a one-line confirmation and stop.\`,
  { label: \`Synthesize: \${args.title}\`, phase: "Synthesize" }
);
`;

// ── Dispatcher type ────────────────────────────────────────────────────────────

type IngestSource = {
  id: string;
  extracted: string;
  manifest: Record<string, unknown>;
};

export type WikiIngestDispatcher = (sources: IngestSource[]) => boolean;

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
      {}) as Record<string, () => ReturnType<typeof createCommitSynthesisTool>[]>;

    const paths = buildVaultPaths();

    for (const source of sources) {
      const toolsetKey = `wiki-synthesis:${source.id}`;
      const title = String(source.manifest.title ?? source.id);

      // Per-source toolset with commit_synthesis tool captured in closure.
      extraToolsets[toolsetKey] = () => [
        createCommitSynthesisTool(source.id, source.manifest, paths),
      ];

      manager.startInBackground(
        WIKI_INGEST_SCRIPT,
        {
          sourceId: source.id,
          title,
          extractedContent: source.extracted.slice(0, 24_000),
        },
        { toolset: toolsetKey },
      );
    }

    return true;
  };

  (globalThis as Record<symbol, unknown>)[DISPATCHER_KEY] = dispatcher;
}
