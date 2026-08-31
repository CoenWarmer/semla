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

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createCodingTools,
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  ACTIVE_WORKFLOW_MANAGER,
  BRIDGE_RUN_STARTED,
  readOrInitSlot,
  readSlot,
  WIKI_INGEST_DISPATCHER,
  WIKI_REINDEX_DISPATCHER,
  WIKI_SESSION_REPOS,
  WORKFLOW_EXTRA_TOOLSETS,
  writeSlot,
  type WikiIngestDispatcher,
  type WikiReindexDispatcher,
} from "../extension-contract.js";
import {
  collectWikiSubagentTools,
  wikiToolsetKey,
} from "./wiki-subagent-tools.js";
import { mergeProvenance, withNamespacedEntities } from "./wiki-page-merge.js";
import { readRepoField } from "./wiki-frontmatter.js";
import { withVaultLock } from "./wiki-vault-lock.js";
import {
  groundingReport,
  type GroundingReport,
} from "./synthesis-grounding.js";

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
  /** Slugs whose page already existed, so this synthesis was dropped for them. */
  entitiesLinked: string[];
  conceptsLinked: string[];
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

/**
 * Record this source against the pages the commit kept rather than created.
 *
 * `commitSynthesis` reports a slug in entitiesLinked/conceptsLinked when the
 * page already existed, and otherwise leaves it completely untouched — so the
 * second source's evidence is dropped. Merging provenance is what makes a
 * cross-repo concept end up with `repo: [a, b]`, which the schema and the
 * graph's shared-node colour already model but no ingest path could produce.
 *
 * Frontmatter only. Reconciling two definitions is the consolidate skill's job.
 */
/** Repo recorded on a source page when it was captured. */
function sourceRepo(paths: WikiVaultPaths, sourceId: string): string | null {
  try {
    return readRepoField(
      readFileSync(join(paths.wiki, "sources", `${sourceId}.md`), "utf8"),
    );
  } catch {
    return null;
  }
}

function mergeLinkedPages(
  paths: WikiVaultPaths,
  committed: { entitiesLinked: string[]; conceptsLinked: string[] },
  sourceId: string,
  repo: string | null,
): void {
  const date = new Date().toISOString().slice(0, 10);
  const groups: Array<[string, string[]]> = [
    ["entities", committed.entitiesLinked],
    ["concepts", committed.conceptsLinked],
  ];

  for (const [dir, slugs] of groups) {
    for (const slug of slugs) {
      const pagePath = join(paths.wiki, dir, `${slug}.md`);
      try {
        const outcome = mergeProvenance(readFileSync(pagePath, "utf8"), {
          sourceId,
          repo,
          date,
        });
        if (outcome.changed) writeFileSync(pagePath, outcome.content, "utf8");
      } catch {
        // A page that cannot be read is left as it is; the commit still stands.
      }
    }
  }
}

// ── Batch commit-synthesis tool factory ───────────────────────────────────────
// One shared tool per batch; source_id param routes each call to the right manifest.

/**
 * Grounding for one source, read from the packet on disk.
 *
 * The packet is the page's source of record, so a claim is judged against all
 * of it — not against the truncated slice the agent was handed, which would
 * report a faithful reading of a long source as an invention.
 */
function reportSynthesisGrounding(
  paths: WikiVaultPaths,
  sourceId: string,
  takeaways: readonly string[],
): GroundingReport {
  try {
    const extracted = readFileSync(
      join(paths.rawSources, sourceId, "extracted.md"),
      "utf8",
    );
    return groundingReport(takeaways, extracted);
  } catch {
    // No packet to check against is not a finding about the synthesis.
    return { ungrounded: [], lowest: 1 };
  }
}

function createBatchCommitSynthesisTool(
  manifests: Map<string, Record<string, unknown>>,
  paths: WikiVaultPaths,
  repoOf: () => string | null,
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

      // Deliberately the *source's* repo, not the session's. pi-llm-wiki reads
      // one literal symbol for the dispatcher and calls it with sources only,
      // so the dispatcher that runs may belong to another concurrent session.
      // The source page already records who captured it, and a batch belongs to
      // the repos of the sources in it whoever dispatched it.
      // Checked before the commit so the report reflects what was proposed,
      // and reported rather than refused: the agent stops after one call, so
      // rejecting here loses the page entirely and leaves the source with no
      // synthesis at all. Visibility first — a warning is what this run did not
      // have.
      const grounding = reportSynthesisGrounding(paths, source_id, params.key_takeaways);
      if (grounding.ungrounded.length > 0) {
        console.warn(
          `[wiki-bridge] ${source_id}: ${grounding.ungrounded.length} of ` +
            `${params.key_takeaways.length} takeaways are not supported by the source. ` +
            `Worst: "${grounding.ungrounded[0]!.text.slice(0, 80)}"`,
        );
      }

      const repo = sourceRepo(paths, source_id) ?? repoOf();
      // Entities are artifacts of one repo, so they are qualified before the
      // package derives a slug from the title. Concepts are shared on purpose
      // and keep their plain names.
      const data = repo
        ? withNamespacedEntities(
            synthesisData as unknown as { entities?: Array<{ title: string }> },
            repo,
          )
        : synthesisData;

      // The whole commit — pages, provenance merge and the derived-file rebuild
      // — is one critical section. A concurrent orient rebuilding halfway
      // through would publish a registry that omits these pages.
      const outcome = await withVaultLock(WIKI_HOME, "commit_synthesis", () => {
        const committed = worker.commitSynthesis(
          paths,
          source_id,
          manifest,
          data as unknown as CommitSynthesisData,
        );

        if (committed.ok) {
          // A slug that was already taken means the package kept the existing
          // page and dropped this synthesis. Record that this source attests to
          // it too, rather than losing the second repo's evidence entirely.
          mergeLinkedPages(paths, committed, source_id, repo);
          meta.rebuildMetadataLight(paths);
        }
        return committed;
      });

      if (!outcome.ok) {
        return {
          content: [
            { type: "text" as const, text: `Failed: ${outcome.diagnostics[0].message}` },
          ],
          details: { source_id } as Record<string, unknown>,
          isError: true,
        };
      }

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

      // In the text, not only in `details`: the transcript records a tool
      // result's text and drops everything else, so a finding filed under
      // details is gone the moment the run ends — which is the audit this was
      // added to make possible.
      const note =
        grounding.ungrounded.length > 0
          ? ` Not supported by the source (${grounding.ungrounded.length} of ` +
            `${params.key_takeaways.length}): ` +
            grounding.ungrounded.map((item) => `"${item.text}"`).join("; ") +
            "."
          : "";

      return {
        content: [
          {
            type: "text" as const,
            text: `${ack}.${note} Reply with a one-line confirmation and stop.`,
          },
        ],
        details: {
          ...outcome,
          ungroundedTakeaways: grounding.ungrounded,
          lowestGrounding: grounding.lowest,
        } as Record<string, unknown>,
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
 * Collection is async — the package is loaded through a computed path — while
 * the manager resolves a toolset synchronously, so the tools are gathered once
 * and the closure serves the cached array.
 *
 * The gathering is awaited in session_start, which pi awaits before the session
 * runs anything. Without that, an orient starting immediately got a toolset
 * that was still empty: some subagents received the wiki tools and some
 * received only coding tools, in the same run, depending on whether the import
 * had resolved yet. If collection fails the tag resolves to the plain coding
 * tools, which is the behaviour before any of this existed.
 */
function registerSubagentWikiToolset(
  pi: ExtensionAPI,
  repoOf: () => string | null,
  sessionIdOf: () => string | undefined,
): void {
  let wikiTools: Array<ReturnType<typeof defineTool>> = [];

  const gathering = collectWikiSubagentTools<ReturnType<typeof defineTool>>(pi, {
    wikiHome: WIKI_HOME,
    repoOf,
  })
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
  const toolset = () => [...createCodingTools(process.cwd()), ...wikiTools];

  // Registered under both the bare tag and this session's own, because the
  // toolset map is shared by every session in the process and these tools close
  // over one session's repo. The bare tag keeps a single-session process and
  // any run started before session_start working.
  extraToolsets[wikiToolsetKey()] = toolset;

  pi.on("session_start", async () => {
    // Awaited: a run started before this resolves would hand some of its
    // subagents wiki tools and others none.
    await gathering;
    const id = sessionIdOf();
    if (id) extraToolsets[wikiToolsetKey(id)] = toolset;
  });
}

export default function wikiIngestBridge(pi: ExtensionAPI) {
  // Captured at session_start and closed over, rather than read from a shared
  // slot at call time: a tool's execute context carries only `cwd`, which every
  // concurrent session shares, so a global "current session" would resolve to
  // whichever session started last.
  let sessionId: string | undefined;
  pi.on("session_start", (_event: unknown, ctx: ExtensionContext) => {
    try {
      sessionId = ctx.sessionManager?.getSessionId();
    } catch {
      // No session id means attribution falls back to the turn-end sweep.
    }
  });

  // Read straight off the shared slot: the server-side half of this pair
  // (wiki-session-repo.ts) imports through the "@/" alias, which jiti cannot
  // resolve from here.
  const repoOf = (): string | null =>
    (sessionId
      ? readOrInitSlot(WIKI_SESSION_REPOS, () => new Map()).get(sessionId)
      : null) ?? null;

  registerSubagentWikiToolset(pi, repoOf, () => sessionId);

  const dispatcher: WikiIngestDispatcher = (sources) => {
    const manager = readSlot(ACTIVE_WORKFLOW_MANAGER);
    if (!manager) return false;

    const extraToolsets = readOrInitSlot(WORKFLOW_EXTRA_TOOLSETS, () => ({}));

    const paths = buildVaultPaths();
    const manifests = new Map(sources.map((s) => [s.id, s.manifest]));
    const toolsetKey = nextRunKey("wiki-synthesis");

    // Single shared commit_synthesis tool — source_id param routes each call.
    extraToolsets[toolsetKey] = () => [createBatchCommitSynthesisTool(manifests, paths, repoOf)];

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
