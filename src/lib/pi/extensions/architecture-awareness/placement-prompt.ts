/**
 * Item 1: unconditional PLACEMENT.md injection.
 *
 * Injects the target repo's PLACEMENT.md (see `placement-rules.ts`) into
 * every system prompt via `before_agent_start`. This is the hook Pi fires
 * with the fully assembled `systemPrompt` string, before the turn's first
 * tool call — so this is never something the agent has to decide to read,
 * unlike a "get architecture context" tool. See `BeforeAgentStartEvent` in
 * pi-coding-agent's extension types.
 *
 * Absent file: inject nothing, log at debug (console.debug) level, do not
 * synthesise a substitute — a repo that has not opted in gets no rules
 * invented for it.
 *
 * Oversized file: this extension does NOT enforce the token cap itself.
 * Pi's `emitBeforeAgentStart` catches every handler error and routes it to an
 * `onError` diagnostic listener rather than letting it fail the turn (see
 * `runner.js`'s `emitBeforeAgentStart` — the catch calls `this.emitError`,
 * nothing rethrows). A `throw` here would be swallowed exactly like a silent
 * truncation would, which is the opposite of "fail loudly at session start".
 * The loud check therefore lives in `session-service.ts`, called
 * synchronously before the session is created — see
 * `assertPlacementFileWithinSessionBudget` below, invoked from there. This
 * handler re-checks defensively and injects nothing (logging a warning) if
 * the file somehow still exceeds budget when a turn reaches it, rather than
 * risk feeding an oversized block into the prompt a second time.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  assertPlacementFileWithinBudget,
  loadPlacementFile,
  PlacementFileTooLargeError,
  type PlacementFile,
} from "./placement-rules";
import { loadArchitectureAwarenessSettings } from "./settings";

export const PLACEMENT_PROMPT_HEADER =
  "# Placement rules (PLACEMENT.md)\n\n" +
  "The target repo defines where new code belongs. These rules are not optional " +
  "guidance — follow them over any inference from grep results about where similar " +
  "code happens to already live.\n\n";

/**
 * The one place both this extension and `placement-tools.ts` (item 3) load
 * PLACEMENT.md from. Does not enforce the token budget — see
 * `assertPlacementFileWithinSessionBudget` for the call that must run first,
 * synchronously, at session start.
 */
export function readPlacementFileForCwd(cwd: string): PlacementFile | null {
  const file = loadPlacementFile(cwd);
  if (!file) {
    console.debug(`[architecture-awareness] no PLACEMENT.md at ${cwd}`);
    return null;
  }
  return file;
}

/**
 * The loud, session-start budget check. Called from `session-service.ts`
 * before the Pi session is constructed — never from inside an extension
 * handler, where a throw would be silently swallowed (see module docblock).
 * Returns the loaded file so the caller isn't forced to read it twice; null
 * when there is no PLACEMENT.md to check.
 */
export function assertPlacementFileWithinSessionBudget(
  cwd: string,
  maxTokens: number,
): PlacementFile | null {
  const file = readPlacementFileForCwd(cwd);
  if (!file) return null;
  assertPlacementFileWithinBudget(file, maxTokens);
  return file;
}

export default function placementPromptExtension(pi: ExtensionAPI) {
  pi.on("before_agent_start", (event, ctx) => {
    const settings = loadArchitectureAwarenessSettings(ctx.cwd);
    if (!settings.placementPromptEnabled) return undefined;

    const file = readPlacementFileForCwd(ctx.cwd);
    if (!file) return undefined;

    try {
      assertPlacementFileWithinBudget(file, settings.placementMaxTokens);
    } catch (err) {
      // The session-start check should already have caught this; reaching
      // here means the file grew between that check and this turn (e.g. a
      // long-running session, edited PLACEMENT.md mid-session). Warn and
      // inject nothing rather than risk a silently swallowed throw.
      const message = err instanceof PlacementFileTooLargeError ? err.message : String(err);
      console.warn(`[architecture-awareness] ${message}`);
      return undefined;
    }

    return {
      systemPrompt: `${event.systemPrompt}\n\n${PLACEMENT_PROMPT_HEADER}${file.contents}`,
    };
  });
}
