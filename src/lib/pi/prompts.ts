import { MEMORY_INJECT_LIMIT, repoMemoryPath } from "@/lib/repo-memories";
import { SEMLA_MEMORIES_DIR } from "@/lib/pi/runtime-config";

/** Base orchestration guidelines — user-editable and shown in the settings UI. */
export const DEFAULT_SYSTEM_PROMPT = `# Semla orchestration guidelines

- When a goal is decomposable, decompose it into smaller subtasks and delegate each to a dedicated subagent. Do not attempt decomposable work yourself.
- After subagents complete their tasks, evaluate whether results can be further decomposed and delegated before synthesising a final answer.
- Keep your own context window small. The brunt of the work — research, implementation, analysis — belongs in subagents, not in your own context.
- Every code change must be verified by a dedicated subagent whose sole responsibility is reviewing the change for code quality and architecture.`;

/**
 * Build the repo memory context block that is always appended to the system
 * prompt by the prompt route. When the memory file has been loaded it is
 * included; otherwise the agent is told where to find the directory and
 * instructed to orient if needed.
 */
export const buildMemoryContextBlock = (
  projectPath: string | null,
  repoMemory: string | null,
): string => {
  const lines: string[] = [
    "# Repo memory",
    "",
    `Codebase memories are stored in \`${SEMLA_MEMORIES_DIR}/\`. Each file is named after the repo's absolute path with every non-alphanumeric character replaced by \`_\` (e.g. \`/Users/coen/Dev/kibana\` → \`Users_coen_Dev_kibana.md\`).`,
  ];

  if (repoMemory && projectPath) {
    const memoryPath = repoMemoryPath(projectPath);
    const truncated = repoMemory.length > MEMORY_INJECT_LIMIT;
    const injected = truncated ? repoMemory.slice(0, MEMORY_INJECT_LIMIT) : repoMemory;

    lines.push(
      "",
      `The memory for \`${projectPath}\` has been loaded below${truncated ? ` (first ${MEMORY_INJECT_LIMIT.toLocaleString()} characters; full file at \`${memoryPath}\`)` : ""}. Use it to inform your work. If you observe something that contradicts the memory, trust your observation and optionally update the relevant section of the file.`,
      "",
      "---",
      "",
      injected,
    );

    if (truncated) {
      lines.push(
        "",
        `*(Memory truncated. Read \`${memoryPath}\` for the complete file.)*`,
      );
    }
  } else if (projectPath) {
    lines.push(
      "",
      `No memory file exists yet for \`${projectPath}\`. Before starting substantive work, invoke the \`orient\` skill to generate one. Orient uses a workflow to scan the codebase in parallel and writes \`${SEMLA_MEMORIES_DIR}/${projectPath.replace(/^\//, "").replace(/[^a-zA-Z0-9]/g, "_")}.md\`.`,
    );
  } else {
    lines.push(
      "",
      "When you begin working in a repository, derive its slug (absolute path, leading `/` stripped, non-alphanumeric characters replaced with `_`) and check whether `$SEMLA_MEMORIES_DIR/{slug}.md` exists. If not, invoke the `orient` skill to generate it before starting substantive work.",
    );
  }

  return lines.join("\n");
};
