/**
 * Whether a prompt-input's current text is a `/skill:name` command still
 * being typed, and if so, the partial name typed so far.
 *
 * `pi-coding-agent`'s `AgentSession._expandSkillCommand` recognises
 * `/skill:name args` at prompt time (see `dist/core/agent-session.js`) and
 * expands it to that skill's body before the model ever sees it. This module
 * exists only to recognise the *same* prefix while it is still being typed,
 * so the UI can offer a filtered picker instead of the user guessing at exact
 * skill names by hand. It never expands anything itself — expansion stays
 * pi's job.
 */

const PREFIX = "/skill:";

/**
 * Returns the partial name after `/skill:` when the text is still a bare
 * command with no arguments yet (no space after the prefix), or `null`
 * otherwise — including once the user has moved on to typing arguments,
 * since at that point the command is committed and a picker would only be in
 * the way.
 */
export function parseSlashSkillQuery(text: string): string | null {
  if (!text.startsWith(PREFIX)) return null;
  const rest = text.slice(PREFIX.length);
  if (rest.includes(" ") || rest.includes("\n")) return null;
  return rest;
}

/** The literal text to insert into the input when a skill is chosen. */
export function slashSkillCommand(skillName: string): string {
  return `${PREFIX}${skillName} `;
}
