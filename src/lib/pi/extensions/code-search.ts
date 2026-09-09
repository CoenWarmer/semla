/**
 * The `code_search` tool: semantic retrieval over the anchored project, and the
 * write hook that keeps the index current with what the agent writes.
 *
 * **Registered unconditionally, even with no index and no credential.** A tool
 * that appears only when some runtime state is right reintroduces the failure
 * `extension-manifest.ts` exists to prevent: the model cannot ask for a
 * capability it cannot see, and cannot report the absence of one it was never
 * offered. Unconfigured, the tool answers with what is missing and how to fix
 * it, which is a result the model can act on.
 *
 * **It is deliberately not the first thing to reach for.** `code_map` resolves
 * a real call graph with the type checker, supi's tools answer symbol queries,
 * and grep answers exact strings — each is better than this at what it does.
 * The gap this fills is the query whose wording does not appear in the code.
 * The description says so, because a tool that oversells itself gets used where
 * a cheaper, exact one would have been right.
 */

import { resolve } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { resolveEmbedder } from "@/lib/code-index/credentials";
import { projectKey } from "@/lib/code-index/index-paths";
import { reindexPaths } from "@/lib/code-index/indexer";
import { createReindexQueue, type ReindexQueue } from "@/lib/code-index/reindex-queue";
import {
  DEFAULT_SEARCH_LIMIT,
  renderSearchResult,
  searchProject,
} from "@/lib/code-index/search";
import { createLocalVectorStore } from "@/lib/code-index/store/local";

const CodeSearchSchema = Type.Object(
  {
    query: Type.String({
      description:
        "What you are looking for, in your own words. Describe the behaviour or " +
        "responsibility, not the identifier — an exact identifier is a job for grep.",
    }),
    kind: Type.Optional(
      Type.Union([Type.Literal("source"), Type.Literal("test")], {
        description:
          'Restrict to implementation ("source") or to tests ("test"). Ranked ' +
          "together when unset, which lets tests dominate — pass \"source\" when " +
          "asking how something works.",
      }),
    ),
    limit: Type.Optional(
      Type.Integer({
        description: `Results to return. Defaults to ${DEFAULT_SEARCH_LIMIT}.`,
        maximum: 25,
        minimum: 1,
      }),
    ),
  },
  { additionalProperties: false },
);

/** Tool names whose results mean a file on disk changed. */
const WRITE_TOOLS = new Set(["edit", "write"]);

export default function codeSearchExtension(pi: ExtensionAPI) {
  // Pi hands the factory process.cwd(), not the session's project; the real one
  // arrives on session_start. Searching the wrong root would silently answer
  // from another repository's index.
  let cwd = process.cwd();
  let queue: ReindexQueue | null = null;

  pi.on("session_start", (_event: unknown, ctx: ExtensionContext) => {
    cwd = resolve(ctx.cwd || process.cwd());
    queue?.dispose();
    queue = createReindexQueue({
      reindex: async (paths) => {
        const embedder = resolveEmbedder();
        if (embedder === null) return;
        await reindexPaths({
          root: cwd,
          project: projectKey(cwd),
          store: createLocalVectorStore(),
          embedder,
          paths,
        });
      },
      // Reported, never raised: the edit that triggered this already succeeded
      // on disk, and the session-start sweep is what catches what is missed.
      onError: (error, paths) => {
        console.warn(
          `[code-index] reindex failed for ${paths.length} path(s): ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      },
    });
  });

  pi.on("session_shutdown", () => {
    queue?.dispose();
    queue = null;
  });

  /**
   * The write hook. Enqueues and returns — see reindex-queue.ts for why this
   * must not await: an embedding round-trip here would put network latency on
   * every file write and turn a rate limit into a failed edit.
   */
  pi.on("tool_result", (event: unknown) => {
    const detail = event as { toolName?: string; args?: { path?: string; file_path?: string } };
    if (detail.toolName === undefined || !WRITE_TOOLS.has(detail.toolName)) return;

    const written = detail.args?.path ?? detail.args?.file_path;
    if (typeof written !== "string" || written.length === 0) return;

    const relative = written.startsWith(cwd)
      ? written.slice(cwd.length).replace(/^\//, "")
      : written;
    queue?.notifyWritten(relative);
  });

  pi.registerTool({
    name: "code_search",
    label: "Code search",
    description:
      "Search the project's code index by meaning, for the question whose wording " +
      "does not appear in the code — \"where do we decide whether a run is still " +
      "alive?\". Prefer grep for an exact string, code_map for what calls what, and " +
      "the code_* tools for a named symbol; this is for finding the right place to " +
      "look when you cannot name it. Results are citations read from disk at query " +
      "time, and say when the index has fallen behind the tree.",
    promptGuidelines: [
      'Describe the behaviour, not the identifier. "retry budget" beats "maxAttempts".',
      'Pass kind: "source" when asking how something works, or tests will outrank the implementation.',
      "Read the cited lines before relying on a hit; the score alone does not separate a good match from a bad one.",
      "Repeat any limits the result states rather than presenting the hits as a complete answer.",
    ],
    parameters: CodeSearchSchema,
    async execute(
      _toolCallId: string,
      params: { kind?: "source" | "test"; limit?: number; query: string },
    ) {
      const embedder = resolveEmbedder();
      if (embedder === null) {
        // Not thrown: this is a configuration answer, not a failure of the call.
        return {
          content: [
            {
              text:
                "No embedding credential is configured, so the code index is off. " +
                "Semla reads it from the `openrouter` entry in its agent directory " +
                "(~/.semla/agent/auth.json). Use grep or code_map meanwhile.",
              type: "text",
            },
          ],
          // Present rather than omitted: Pi's result type requires the field,
          // and an absent one is a different shape from an empty one.
          details: undefined,
        };
      }

      const result = await searchProject({
        root: cwd,
        project: projectKey(cwd),
        store: createLocalVectorStore(),
        embedder,
        query: params.query,
        limit: params.limit,
        kind: params.kind,
      });

      return {
        content: [{ text: renderSearchResult(result, params.query), type: "text" }],
        details: { result, type: "code-search" },
      };
    },
  });
}
