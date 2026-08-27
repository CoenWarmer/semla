import { WIKI_HOME } from "@/lib/pi/runtime-config";

/** Base orchestration guidelines — user-editable and shown in the settings UI. */
export const DEFAULT_SYSTEM_PROMPT = `# Semla orchestration guidelines

- When a goal is decomposable, decompose it into smaller subtasks and delegate each to a dedicated subagent. Do not attempt decomposable work yourself.
- After subagents complete their tasks, evaluate whether results can be further decomposed and delegated before synthesising a final answer.
- Keep your own context window small. The brunt of the work — research, implementation, analysis — belongs in subagents, not in your own context.
- Every code change must be verified by a dedicated subagent whose sole responsibility is reviewing the change for code quality and architecture.`;

/**
 * Build the repo memory context block appended to the system prompt on every
 * prompt. Tells the agent where the wiki lives, which project is active, and
 * whether to orient first.
 */
export const buildMemoryContextBlock = (
  projectPath: string | null,
): string => {
  const lines = [
    "# Codebase wiki",
    "",
    `This Semla instance uses **pi-llm-wiki** for persistent codebase knowledge. The personal vault is at \`${WIKI_HOME}/.llm-wiki/\`.`,
    "",
    "**At the start of every task:** call `wiki_recall` with the repo name and a few task-relevant keywords to surface relevant wiki pages before you begin.",
    "**At the end of every task:** call `/wiki-retro` to save non-obvious insights, patterns, or decisions from the work you just completed.",
  ];

  if (projectPath) {
    lines.push(
      "",
      `The active project for this session is \`${projectPath}\`.`,
      "",
      "Before starting work: call `wiki_recall` with the project name to check for existing codebase knowledge. If no pages are returned, invoke the `orient` skill to initialise the wiki for this repo.",
    );
  }

  return lines.join("\n");
};
