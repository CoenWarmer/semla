/**
 * Item 3: `edit`/`write` replaced by Semla's own versions requiring
 * `target_module` and `rationale`.
 *
 * Pi's built-in `edit`/`write` tools have a fixed schema
 * (`createEditToolDefinition`/`createWriteToolDefinition` in
 * `@earendil-works/pi-coding-agent`'s tools module) that an extension cannot
 * extend — `registerTool` only registers a *new* tool. So this module
 * registers replacement tools under the same names (`edit`, `write`),
 * delegating the actual file I/O to Pi's own `createEditTool`/`createWriteTool`
 * so diff/patch generation and `firstChangedLine` behave identically to the
 * stock tools. Only the schema and a pre-check are new.
 *
 * Semla's session bootstrap must exclude the built-in `edit`/`write` from
 * the active tool set (`excludeTools` in `createAgentSession`) — see
 * `session-service.ts` — and `assertManifestIsCoherent`'s builtin-collision
 * check has a named exception for this extension's id, matching the existing
 * exception for `workflow`/`ask-user`.
 *
 * The rejection path: `target_module` is checked against the target repo's
 * PLACEMENT.md rules (`placement-rules.ts`, shared with item 1). On a
 * contradiction the tool returns an error result quoting the matching rule
 * — never a thrown exception, since a rejected tool call is a normal,
 * recoverable outcome the agent should see and act on, not a session-ending
 * failure.
 *
 * Both `target_module` and `rationale` are logged via `sessionLog` on every
 * accepted call, so rationale quality (substantive vs. boilerplate) is
 * reviewable later — see the `architecture-awareness.placement-tools` log
 * lines.
 */

import {
  createEditToolDefinition,
  createWriteToolDefinition,
  type AgentToolResult,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

import { sessionLog } from "@/lib/pi/session-log";

import { renderEnforcementFeedback, runEnforcementCommand } from "./enforcement-loop";
import { checkPlacement, type PlacementRule } from "./placement-rules";
import { readPlacementFileForCwd } from "./placement-prompt";
import { loadArchitectureAwarenessSettings } from "./settings";

const PlacementFieldsSchema = Type.Object({
  target_module: Type.String({
    description:
      "The directory or module this change belongs in, e.g. \"server/routes/\". " +
      "Checked against the target repo's PLACEMENT.md, if one exists.",
  }),
  rationale: Type.String({
    description: "One line: why this change belongs in target_module.",
  }),
});

const EditEntrySchema = Type.Object({
  oldText: Type.String(),
  newText: Type.String(),
});

const EditSchema = Type.Object({
  path: Type.String(),
  edits: Type.Array(EditEntrySchema),
  target_module: PlacementFieldsSchema.properties.target_module,
  rationale: PlacementFieldsSchema.properties.rationale,
});

const WriteSchema = Type.Object({
  path: Type.String(),
  content: Type.String(),
  target_module: PlacementFieldsSchema.properties.target_module,
  rationale: PlacementFieldsSchema.properties.rationale,
});

export type PlacementEditInput = Static<typeof EditSchema>;
export type PlacementWriteInput = Static<typeof WriteSchema>;

/** Formats the rejection message so it quotes the PLACEMENT.md rule verbatim. */
function rejectionMessage(targetModule: string, rules: readonly PlacementRule[]): string {
  const closest = rules.find((rule) =>
    targetModule.toLowerCase().includes(rule.situation.toLowerCase().split(" ")[0] ?? ""),
  );
  const quoted = closest ? `"${closest.raw}"` : rules.map((r) => `"${r.raw}"`).join(", ");
  return (
    `target_module "${targetModule}" does not match PLACEMENT.md. ` +
    `Matching rule(s): ${quoted}`
  );
}

function checkAndLog(
  ctx: ExtensionContext,
  toolName: "edit" | "write",
  targetModule: string,
  rationale: string,
  path: string,
): { rejected: false } | { rejected: true; message: string } {
  const settings = loadArchitectureAwarenessSettings(ctx.cwd);
  const sessionId = ctx.sessionManager.getSessionId();

  const file = readPlacementFileForCwd(ctx.cwd);
  const rules = file?.rules ?? [];
  const check = checkPlacement(targetModule, rules);

  if (!check.allowed) {
    sessionLog(sessionId, `architecture-awareness.placement-tools ${toolName} rejected`, {
      path,
      rationale,
      target_module: targetModule,
    });
    return { rejected: true, message: rejectionMessage(targetModule, rules) };
  }

  if (settings.placementToolsEnabled) {
    sessionLog(sessionId, `architecture-awareness.placement-tools ${toolName} accepted`, {
      path,
      rationale,
      target_module: targetModule,
    });
  }

  return { rejected: false };
}

/**
 * Item 4: run the configured enforcement command after an accepted edit, and
 * fold its output into the tool result the model reads. Never fatal, and
 * never run when the delegate's own result was already an error — a failed
 * edit has nothing to lint yet.
 */
async function withEnforcementFeedback<T>(
  ctx: ExtensionContext,
  result: AgentToolResult<T>,
): Promise<AgentToolResult<T>> {
  // The delegate (Pi's own edit/write tool) throws rather than returning an
  // error result — see code-map.ts's comment on the same convention — so
  // reaching this point means the edit/write already succeeded. No isError
  // check is needed or possible: AgentToolResult carries no such field (only
  // the ToolResultMessage wrapper around it does).
  const settings = loadArchitectureAwarenessSettings(ctx.cwd);
  if (!settings.enforcementEnabled || !settings.enforcementCommand) return result;

  const enforcement = await runEnforcementCommand(settings.enforcementCommand, ctx.cwd);
  const feedback = renderEnforcementFeedback(enforcement);
  if (!feedback) return result;

  return {
    ...result,
    content: [...result.content, { text: feedback.trimStart(), type: "text" }],
  };
}

export default function placementToolsExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "edit",
    label: "Edit",
    description:
      "Edit a single file using exact text replacement, and declare which module the " +
      "change belongs in and why. Every oldText must match a unique region of the file.",
    parameters: EditSchema,
    promptGuidelines: [
      "target_module must name the directory the change belongs in — checked against the target repo's PLACEMENT.md when one exists.",
      "rationale is one line: why this file, in this module. Reviewed later, so make it substantive, not boilerplate.",
    ],
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const outcome = checkAndLog(ctx, "edit", params.target_module, params.rationale, params.path);
      if (outcome.rejected) {
        return {
          content: [{ type: "text", text: outcome.message }],
          details: undefined,
          isError: true,
        };
      }

      const delegate = createEditToolDefinition(ctx.cwd);
      const result = await delegate.execute(
        toolCallId,
        { edits: params.edits, path: params.path },
        signal,
        onUpdate,
        ctx,
      );
      return withEnforcementFeedback(ctx, result);
    },
  });

  pi.registerTool({
    name: "write",
    label: "Write",
    description:
      "Write content to a file, creating it or overwriting it, and declare which module " +
      "the file belongs in and why.",
    parameters: WriteSchema,
    promptGuidelines: [
      "target_module must name the directory the file belongs in — checked against the target repo's PLACEMENT.md when one exists.",
      "rationale is one line: why this file, in this module. Reviewed later, so make it substantive, not boilerplate.",
    ],
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const outcome = checkAndLog(ctx, "write", params.target_module, params.rationale, params.path);
      if (outcome.rejected) {
        return {
          content: [{ type: "text", text: outcome.message }],
          details: undefined,
          isError: true,
        };
      }

      const delegate = createWriteToolDefinition(ctx.cwd);
      const result = await delegate.execute(
        toolCallId,
        { content: params.content, path: params.path },
        signal,
        onUpdate,
        ctx,
      );
      return withEnforcementFeedback(ctx, result);
    },
  });
}
