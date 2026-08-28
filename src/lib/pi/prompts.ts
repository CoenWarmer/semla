import { WIKI_HOME } from "@/lib/pi/runtime-config";
import { repoSlugFromProjectPath } from "@/lib/pi/wiki-repo-stamp";

// DEFAULT_SYSTEM_PROMPT lives in system-prompt.ts, not here: this module pulls
// in runtime-config (and through it pi-coding-agent), which must never reach a
// client bundle.

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
    "",
    "## Wiki wikilink format",
    "",
    "Always use **path-based wikilinks** when writing wiki page content: `[[entities/slug]]`, `[[concepts/slug]]`, `[[sources/SRC-xxx]]`, etc.",
    "Never use bare title wikilinks (`[[Page Title]]`) — the link resolver treats targets as literal page IDs, so bare titles never resolve.",
    "Do not write `[[...]]` inside inline code spans — the extractor is not code-span-aware and will treat it as a live link.",
    "",
    "## Wiki page frontmatter",
    "",
    "Every wiki page you create or update **must** include a `repo:` field in its YAML frontmatter:",
    "- Single repo: `repo: semla`",
    "- Page that spans multiple repos: `repo: [semla, ecs]` (YAML list)",
    "Use the repository directory name as the slug — never an absolute path.",
    "`repo:` belongs **inside the page's existing `---` frontmatter block**, alongside `type:` and `title:`.",
    "Never append a second `---` block to add it: only the first block is parsed, so a later one is read as body text and the field is lost.",
    "Pages about generic tools or cross-cutting concepts that genuinely belong to no single repo may omit `repo:`.",
    "",
    "## Wiki orientation guidelines",
    "",
    "**Ingestion job safety — do not re-call `wiki_ingest` while jobs are in flight.**",
    "A source is not locked when a background job claims it — re-calling `wiki_ingest` re-queues unfinished sources into new duplicate background jobs.",
    "Wait for each batch's completion notification, or use `workflow_control` with `action: list` to confirm no `status: running` jobs remain, before issuing the next `wiki_ingest`.",
    "",
    "**Capture at module/concern granularity, not per file.**",
    "Prefer 5–8 coarse sources (e.g. \"main-process modules\" as one concatenated capture) over one source per individual file.",
    "Each source is synthesised independently with no visibility into other sources, so finer granularity directly multiplies fragment count and orphan risk.",
    "",
    "**For repos under ~30 source files, skip the capture pipeline entirely.**",
    "Read the code directly and hand-write entity/concept pages — reserve `wiki_capture_source`/`wiki_ingest` for genuinely large or unfamiliar codebases where manual synthesis is not feasible.",
    "",
    "**Post-ingestion hygiene is mandatory.**",
    "After any `wiki_ingest` run that processes more than ~5 sources, immediately run `wiki_lint` and check the orphan count.",
    "If orphans exceed ~20 % of total pages, run the consolidate skill before considering the task done.",
  ];

  if (projectPath) {
    lines.push(
      "",
      `The active project for this session is \`${projectPath}\`.`,
      `For pages about this project, use \`repo: ${repoSlugFromProjectPath(projectPath)}\` in frontmatter.`,
      "",
      "Before starting work: call `wiki_recall` with the project name to check for existing codebase knowledge. If no pages are returned, invoke the `orient` skill to initialise the wiki for this repo.",
    );
  }

  return lines.join("\n");
};
