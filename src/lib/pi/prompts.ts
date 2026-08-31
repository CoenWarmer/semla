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
    "## Entity vs concept naming",
    "",
    "**Entity** pages describe artifacts of one repo (a file, class or symbol), so qualify their titles with the repo: `semla README.md`, not `README.md`.",
    "Two repos both have a `README.md`; an unqualified title makes the first one written win the page and the second lose its content entirely.",
    "**Concept** pages describe repo-independent ideas and are deliberately shared — never qualify those, and let a concept both repos have accumulate `repo: [a, b]`.",
    "",
    "## Person entities",
    "",
    "A person — an author, reviewer or team member — is not an artifact of one repo, so they get their own page type: `wiki_ensure_page(type: \"person\", title: \"Coen Warmer\")`.",
    "Pass the plain name as the title. The canonical slug `{firstname-lastname}` is derived from it, so `Coen Warmer` becomes `coen-warmer` — never pre-qualify the title with a repo, and never hand-build the slug.",
    "The page is filed under `concepts/` because that is the fallback folder for a type the package does not map. That is expected: `type: person` in the frontmatter is what identifies it, and the registry, the graph and `wiki_search`'s type filter all read that field.",
    "One person is one page across every repo. Accumulate `repo: [a, b]` on it as more repos surface the same name; do not create a second page per repo the person touches.",
    "**`wiki_search` for the name before creating one.**",
    "Person pages fragment easily because independent ingests of different sources each mint their own variant — `Coen Warmer`, `CoenWarmer` and `nightshift-program Coen Warmer` have all existed as separate pages in this vault, while the repos where that person was the primary author had no page at all.",
    "If a match exists, extend it and add sources; do not create a sibling.",
    "",
    "## Organisation entities",
    "",
    "An organisation — the owner of a GitHub repository, or a team or vendor a repo depends on — is repo-independent and gets its own type: `wiki_ensure_page(type: \"organisation\", title: \"elastic\")`.",
    "Spell the type `organisation`. `type` is a free-form string with no validation, so `organization` silently creates a second, parallel type that nothing will ever merge with the first.",
    "Title it with the owner handle exactly as the remote spells it — `elastic` from `github.com:elastic/kibana`, giving the slug `elastic`. Read it with `git -C \"$REPO\" remote get-url origin`.",
    "**The owner of a repository is not necessarily an organisation.** A GitHub remote owned by a personal account — `github.com:CoenWarmer/semla` — names a *person*, not an org.",
    "Creating an organisation for a personal account is how `CoenWarmer` came to exist in this vault as a page separate from `Coen Warmer`, splitting one human in two. When the owner is a personal account, merge it into that person\'s page under the person rule above instead.",
    "One organisation is one page across every repo it owns. Accumulate `repo: [a, b]` on it, and `wiki_search` for the handle before creating one.",
    "",
    "## Wiki orientation guidelines",
    "",
    "**Workflow subagents already have the wiki tools.**",
    "A subagent can call `wiki_capture_source`, `wiki_ensure_page`, `wiki_search`, `wiki_status` and `wiki_log_event` directly — fan capture out and let each agent capture its own share.",
    "Never have a subagent return captured file contents for you to capture on its behalf: it should call the tool and report back only the source ID.",
    "`wiki_ingest` is deliberately withheld from subagents, because it starts a background run of its own — call it yourself once the capture workflow has finished.",
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
