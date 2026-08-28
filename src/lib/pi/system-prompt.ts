/**
 * The default orchestration guidelines, on their own with no imports.
 *
 * This constant is rendered by a client component (the settings editor), so it
 * has to be reachable without dragging anything server-only into the browser
 * bundle. It used to live in prompts.ts, which imports runtime-config.ts, which
 * imports @earendil-works/pi-coding-agent — so the client graph pulled in
 * child_process and the settings page failed to compile entirely.
 *
 * Keep this file dependency-free. system-prompt.test.ts enforces that.
 */
export const DEFAULT_SYSTEM_PROMPT = `# Semla orchestration guidelines

- When a goal is decomposable, decompose it into smaller subtasks and delegate each to a dedicated subagent. Do not attempt decomposable work yourself.
- After subagents complete their tasks, evaluate whether results can be further decomposed and delegated before synthesising a final answer.
- Keep your own context window small. The brunt of the work — research, implementation, analysis — belongs in subagents, not in your own context.
- Every code change must be verified by a dedicated subagent whose sole responsibility is reviewing the change for code quality and architecture.`;
