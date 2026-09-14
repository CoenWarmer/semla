/**
 * Item 2: SPEC.md write + injection extension.
 *
 * Both halves run from the same `before_agent_start` hook Pi fires with the
 * raw user prompt text, before any tool call — the one place the verbatim
 * message is available without re-deriving it from the session tree. The
 * write happens first (this turn's prompt is appended), then the whole log
 * — including the just-appended turn — is rendered and injected into the
 * system prompt, so item 2 does not depend on `tool_call` the way the
 * original plan sketch assumed. See spec-log.ts's module docblock for why
 * `tool_call`'s result shape cannot inject prompt content at all — it only
 * blocks/allows, per `ToolCallEventResult` in pi-coding-agent's extension
 * types — and injecting once per turn (which subsumes "before every
 * edit-tool call", since it happens before the model can call one) is
 * strictly more defensive than injecting only immediately before edit/write.
 *
 * SPEC.md survives compaction by construction: it is read from disk on every
 * turn, never carried as part of the message history that gets compacted.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  appendSpecTurn,
  parseSpecMarker,
  readSpecLog,
  renderSpecLog,
} from "./spec-log";
import { loadArchitectureAwarenessSettings } from "./settings";

export const SPEC_LOG_HEADER =
  "# Session requirements (SPEC.md)\n\n" +
  "Every constraint the operator has stated this session, verbatim, in the order given. " +
  "A later line supersedes an earlier one when they conflict — there is no other " +
  "resolution rule here. `@spec`-marked lines are load-bearing and are listed first.\n\n";

export default function specPersistenceExtension(pi: ExtensionAPI) {
  pi.on("before_agent_start", (event, ctx) => {
    const settings = loadArchitectureAwarenessSettings(ctx.cwd);
    if (!settings.specPersistenceEnabled) return undefined;

    const sessionDir = ctx.sessionManager.getSessionDir();
    const sessionId = ctx.sessionManager.getSessionId();

    // Only a genuine user turn is persisted. `event.prompt` is empty for a
    // programmatic continuation (e.g. a background workflow result being
    // delivered as a follow-up), and an empty line would otherwise pollute
    // the append-only log with nothing to show for it.
    if (event.prompt.trim().length > 0) {
      const { loadBearing, text } = parseSpecMarker(event.prompt);
      appendSpecTurn(sessionDir, sessionId, {
        loadBearing,
        text,
        timestamp: new Date().toISOString(),
        // Best-effort ordinal: the file's own line count is the turn index,
        // since this hook fires once per real user turn and nothing else
        // appends to this file.
        turnIndex: readSpecLog(sessionDir, sessionId).length,
      });
    }

    const turns = readSpecLog(sessionDir, sessionId);
    if (turns.length === 0) return undefined;

    return {
      systemPrompt: `${event.systemPrompt}\n\n${SPEC_LOG_HEADER}${renderSpecLog(turns)}`,
    };
  });
}
