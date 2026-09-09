/**
 * The prompt one subagent turn is given: the run's standing instructions, the
 * agent's own, its label, the task, and — for a schema agent — the output
 * contract that makes structured_output the required final action.
 *
 * Split out of agent.ts as a pure string assembly, so a change to the contract
 * wording is testable without constructing a session.
 */

import type { AgentRunOptions } from "./agent-types.ts";

export function buildSubagentPrompt(
  prompt: string,
  options: AgentRunOptions<any>,
  structured: boolean,
  instructions: string | undefined,
): string {
  const parts = [
    instructions,
    options.instructions,
    options.label ? `Task label: ${options.label}` : undefined,
    prompt,
  ].filter(Boolean);

  if (structured) {
    parts.push(
      [
        "Final output contract:",
        "- Your final action MUST be a structured_output tool call.",
        "- The structured_output arguments are the return value of this subagent.",
        "- Do not emit a prose final answer instead of structured_output.",
        "- If you need to inspect files or run commands first, do so, then call structured_output exactly once.",
      ].join("\n"),
    );
  }

  return parts.join("\n\n");
}
