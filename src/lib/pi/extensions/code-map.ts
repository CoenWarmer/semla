/**
 * The `code_map` tool: resolve a call graph and hand back both a readable
 * summary and the structured map the panel draws.
 *
 * Semla owns this tool, which is the whole reason the structured map survives.
 * A third-party tool's result reaches the session as model-facing text — supi's
 * code_graph, for instance, formats its entries into strings and caps them at
 * twenty before anything outside the package sees them. Owning the registration
 * means the `CodeMap` travels intact in `details`, and session-service can
 * persist and draw the same object the checker produced rather than trying to
 * recover a graph from prose.
 *
 * The tool is deliberately narrow: one entry symbol, bounded depth, bounded
 * node count. A whole-repository map is not a useful thing to look at, and the
 * question this answers is always about a particular piece of code.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { resolve } from "node:path";

import { Type } from "typebox";

import {
  buildCodeMap,
  DEFAULT_DEPTH,
  DEFAULT_MAX_NODES,
  SymbolNotFoundError,
} from "../../code-map/call-graph";
import { renderCodeMapText } from "../../code-map/render";

const CodeMapSchema = Type.Object(
  {
    file: Type.String({
      description:
        "Path to the file holding the entry symbol, relative to the project root.",
    }),
    symbol: Type.String({
      description:
        "Name of the function, method or class to map from. Use `ClassName.method` when a bare name is ambiguous.",
    }),
    depth: Type.Optional(
      Type.Integer({
        description: `How many call hops to follow outward. Defaults to ${DEFAULT_DEPTH}.`,
        maximum: 6,
        minimum: 1,
      }),
    ),
    maxNodes: Type.Optional(
      Type.Integer({
        description: `Upper bound on functions drawn. Defaults to ${DEFAULT_MAX_NODES}.`,
        maximum: 300,
        minimum: 2,
      }),
    ),
    includeExternal: Type.Optional(
      Type.Boolean({
        description:
          "Include calls into node_modules and the standard library. Off by default; turning it on buries the project's own structure under Array and Map methods.",
      }),
    ),
  },
  { additionalProperties: false },
);

export default function codeMapExtension(pi: ExtensionAPI) {
  // Pi does not pass the host session's cwd into the factory, only
  // process.cwd() — the same constraint workflow.ts documents. The real project
  // arrives on session_start, and a map built against the wrong project would
  // resolve nothing.
  let cwd = process.cwd();
  pi.on("session_start", (_event: unknown, ctx: ExtensionContext) => {
    cwd = resolve(ctx.cwd || process.cwd());
  });

  pi.registerTool({
    name: "code_map",
    label: "Code map",
    description:
      "Resolve the call graph around one symbol using the TypeScript type checker, " +
      "and draw it in the session's code map panel. Every edge is a call the checker " +
      "traced to a declaration, with the line it appears on. Use this when explaining " +
      "how a piece of code works, so the explanation is grounded in the real call " +
      "structure rather than in a reading of the file. TypeScript and JavaScript only.",
    promptGuidelines: [
      "Give the entry symbol the user actually asked about; do not map a whole file symbol by symbol.",
      "Start at the default depth. Raise it only when the answer genuinely needs another hop.",
      "Report what the map says is unresolved or truncated instead of describing the graph as complete.",
    ],
    parameters: CodeMapSchema,
    async execute(
      _toolCallId: string,
      params: {
        depth?: number;
        file: string;
        includeExternal?: boolean;
        maxNodes?: number;
        symbol: string;
      },
    ) {
      try {
        const map = buildCodeMap({ cwd, ...params });

        return {
          content: [{ text: renderCodeMapText(map), type: "text" }],
          details: { map, type: "code-map" },
        };
      } catch (error) {
        // A missing symbol is the common case and is recoverable: the error
        // carries the names that do exist, so the model can retry rather than
        // give up or invent one.
        const message =
          error instanceof SymbolNotFoundError
            ? error.message
            : error instanceof Error
              ? error.message
              : String(error);

        return {
          content: [{ text: message, type: "text" }],
          details: null,
          isError: true,
        };
      }
    },
  });
}
