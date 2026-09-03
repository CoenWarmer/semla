/**
 * The prompt the review panel's "Explain function" sends.
 *
 * A function rather than a template inlined at the call site, because what it
 * asks for is a product decision worth being able to read and change in one
 * place — and worth a test, since a prompt that omits the line range sends the
 * agent to guess at which of three same-named functions was meant.
 *
 * It names the location and asks the agent to read it rather than pasting the
 * body in. The agent has `read`, the file is on disk in front of it, and a
 * pasted copy would go stale the moment the operator edits — which, in a panel
 * whose other half is an editor, is likely.
 */

export interface ExplainFunctionInput {
  /** Workspace-relative project path, as the panel keys everything by. */
  project: string;
  /** Project-relative file path. */
  path: string;
  /** `handlePrompt`, or `Pipeline.run`. */
  symbol: string;
  startLine: number;
  endLine: number;
  /** True when the turn being reviewed changed this file. */
  changed?: boolean;
}

export function explainFunctionPrompt({
  changed = false,
  endLine,
  path,
  project,
  startLine,
  symbol,
}: ExplainFunctionInput): string {
  const range =
    startLine === endLine ? `line ${startLine}` : `lines ${startLine}-${endLine}`;

  return [
    `Explain \`${symbol}\` in \`${project}/${path}\` (${range}).`,
    "",
    changed
      ? "I am reviewing a change to this file, so say what the function does" +
        " now and call out anything in it that looks wrong or surprising."
      : "Say what it does, what calls it and what it calls, and anything about" +
        " it that would surprise a reader.",
    "",
    "Read the file rather than working from the name.",
  ].join("\n");
}
