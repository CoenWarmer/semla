"use client";

/**
 * The session summary card: what this session is for, what it cost, who did
 * the work, and what went in and came out.
 *
 * Presentational only. Everything it draws is decided in
 * `src/lib/session/session-summary.ts` and `wiki-activity.ts`, which are pure
 * and tested — this repo runs no jsdom, so any rule worth asserting lives
 * there rather than here. The card's own job is layout.
 *
 * Three things it deliberately does not do:
 *
 *  - it does not fetch. The session page already holds the transcript, the
 *    workflow runs and the status poll, so a second source here would be a
 *    third opinion on numbers that must agree (see session-usage.ts on what
 *    happens when two places compute a session's cost independently).
 *  - it does not present recall as usage. "Offered" and "opened" are separate
 *    rows because 91.4% of recall injections are inert; collapsing them would
 *    claim the wiki informed work it never touched.
 *  - it does not reuse the sidebar's artifact chips as buttons. Those chips
 *    carry a click-through into ReviewPanel via `ElementTargetProvider`, and
 *    the card sits next to the conversation rather than inside that protocol.
 *    Counts here, click-through in the sidebar where it already works.
 */

import {
  BookOpenIcon,
  BotIcon,
  FileDiffIcon,
  FileTextIcon,
  FolderIcon,
  GitCommitHorizontalIcon,
  GitPullRequestIcon,
  MapIcon,
  PencilLineIcon,
  SparklesIcon,
} from "lucide-react";

import { TokenUsage, formatCost } from "@/components/token-usage";
import {
  artifactGroups,
  chipRowLabel,
  groupHeading,
  type ArtifactGroupKind,
} from "@/lib/artifacts/artifact-groups";
import type { ArtifactChip } from "@/lib/artifacts/artifact-summary";
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { SessionSummary, SummaryAgent } from "@/lib/session/session-summary";
import { summaryAgents } from "@/lib/session/session-summary";
import type { WikiPageRef } from "@/lib/session/wiki-activity";
import { hasWikiActivity } from "@/lib/session/wiki-activity";
import { cn } from "@/lib/utils";

/** A labelled block with a heading, the card's one structural unit. */
function Section({
  children,
  icon: Icon,
  title,
}: {
  children: React.ReactNode;
  icon: typeof FileDiffIcon;
  title: string;
}) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Icon className="size-3.5 shrink-0" />
        {title}
      </h3>
      {children}
    </section>
  );
}

/** The dot beside an agent row. Mirrors the timeline's status colours. */
function StatusDot({ status }: { status: SummaryAgent["status"] }) {
  return (
    <span
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        status === "running" && "bg-green-500",
        status === "error" && "bg-destructive",
        status === "queued" && "bg-muted-foreground/40",
        (status === "done" || status === "skipped") && "bg-muted-foreground",
      )}
      title={status}
    />
  );
}

/**
 * One agent: who it was, on what model, for how much.
 *
 * Per-agent rather than one model per session, because a multi-agent session
 * has no single answer — a workflow's phases run on different tiers by
 * design, so naming one model would be wrong about the others.
 */
function AgentRow({ agent }: { agent: SummaryAgent }) {
  return (
    <div className="flex items-center gap-1.5 text-xs">
      <StatusDot status={agent.status} />
      <span className="truncate font-medium">{agent.label}</span>
      {agent.model && (
        <span className="truncate text-muted-foreground" title={agent.model}>
          {agent.model}
        </span>
      )}
      {agent.phase && (
        <span className="shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground">
          {agent.phase}
        </span>
      )}
      <TokenUsage
        className="ml-auto shrink-0 text-muted-foreground"
        cost={agent.cost}
        tokens={agent.tokens}
      />
    </div>
  );
}

/** Wiki pages behind a count, listed in a popover. */
function WikiRow({
  label,
  pages,
  title,
}: {
  label: string;
  pages: readonly WikiPageRef[];
  title: string;
}) {
  if (pages.length === 0) return null;

  return (
    <Popover>
      <PopoverTrigger
        className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-xs hover:bg-accent"
        title={title}
      >
        <span className="text-muted-foreground">{label}</span>
        <span className="ml-auto tabular-nums">{pages.length}</span>
      </PopoverTrigger>
      <PopoverContent className="w-80">
        <PopoverHeader>
          <PopoverTitle>{label}</PopoverTitle>
          <span className="text-xs text-muted-foreground">{title}</span>
        </PopoverHeader>
        <div className="flex max-h-64 flex-col gap-0.5 overflow-y-auto">
          {pages.map((page) => (
            <span className="flex items-center gap-1.5 text-xs" key={page.id}>
              <span className="shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground">
                {page.folder}
              </span>
              <span className="truncate" title={page.id}>
                {page.label}
              </span>
            </span>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

const GROUP_ICON: Record<ArtifactGroupKind, typeof FileDiffIcon> = {
  commit: GitCommitHorizontalIcon,
  diff: FileDiffIcon,
  plan: MapIcon,
  pr: GitPullRequestIcon,
  spec: FileTextIcon,
};

/**
 * One artifact, as a row that opens it.
 *
 * A spec has no file, no hunk and no url, so there is nothing for
 * `ElementTarget` to address (see `artifactTargetFor`'s docblock on why
 * reusing it for a requirement would mean inventing a code location). It
 * renders as static text rather than a dead button. A PR opens its own url,
 * so it is an anchor and never routes through the panel — the same split
 * `ArtifactChipButton` makes in the sidebar.
 */
function ArtifactRow({
  chip,
  onOpen,
}: {
  chip: ArtifactChip;
  onOpen: (chip: ArtifactChip) => void;
}) {
  const label = chipRowLabel(chip);
  // A turn-attributed artifact was not traced to a single tool call. The
  // ambiguity stays visible rather than being laundered away, the same rule
  // `chipDisplay` applies in the sidebar.
  const muted = chip.attribution === "turn";
  const title = muted
    ? "Not attributable to a single tool call"
    : (chip.projectPath ?? label);

  if (chip.kind === "spec") {
    return (
      <span className="flex items-center gap-1.5 px-1 py-0.5 text-xs" title={chip.spec?.text}>
        <span className="truncate text-muted-foreground">{label}</span>
      </span>
    );
  }

  if (chip.kind === "pr" && chip.url) {
    return (
      <a
        className="flex items-center gap-1.5 rounded px-1 py-0.5 text-xs hover:bg-accent"
        href={chip.url}
        rel="noreferrer"
        target="_blank"
        title={chip.url}
      >
        <span className="truncate">{label}</span>
      </a>
    );
  }

  return (
    <button
      className="flex items-center gap-1.5 rounded px-1 py-0.5 text-left text-xs hover:bg-accent disabled:opacity-70"
      disabled={chip.target === null}
      onClick={() => onOpen(chip)}
      style={muted ? { opacity: 0.7 } : undefined}
      title={title}
      type="button"
    >
      <span
        className={cn(
          "truncate",
          chip.role?.source === "inferred" && "underline decoration-dotted underline-offset-2",
        )}
      >
        {label}
      </span>
    </button>
  );
}

/**
 * Produced artifacts, one group per kind, every entry a link.
 *
 * Counts come from the groups rather than from `ArtifactSummary`, and plans
 * are partitioned out of diffs rather than listed in both — see
 * artifact-groups.ts for why each of those matters here and not in the
 * sidebar's count strip.
 */
function ArtifactCounts({
  onOpenArtifact,
  summary,
}: {
  onOpenArtifact: (chip: ArtifactChip) => void;
  summary: SessionSummary;
}) {
  const groups = artifactGroups(summary.artifacts);

  if (groups.length === 0) {
    return <span className="text-xs text-muted-foreground">Nothing produced yet.</span>;
  }

  return (
    <div className="flex flex-col gap-2">
      {groups.map((group) => {
        const Icon = GROUP_ICON[group.kind];
        return (
          <div className="flex flex-col gap-0.5" key={group.kind}>
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <Icon className="size-3 shrink-0" />
              {groupHeading(group)}
            </span>
            <div className="flex flex-col gap-0.5 pl-4">
              {group.chips.map((chip) => (
                <ArtifactRow chip={chip} key={chip.key} onOpen={onOpenArtifact} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function SessionSummaryCard({
  onOpenArtifact,
  summary,
}: {
  /** Opens an artifact in the review panel. See `artifactTargetFor`. */
  onOpenArtifact: (chip: ArtifactChip) => void;
  summary: SessionSummary;
}) {
  const agents = summaryAgents(summary);
  const { wiki } = summary;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto rounded-lg border p-3">
      <header className="flex flex-col gap-1 border-b pb-2">
        <h2 className="truncate text-sm font-semibold">
          {summary.title ?? "Untitled session"}
        </h2>
        {summary.goal ? (
          <p className="text-xs whitespace-pre-wrap text-muted-foreground">{summary.goal}</p>
        ) : (
          <p className="text-xs text-muted-foreground italic">No goal set.</p>
        )}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1">
          {summary.projects.map((project) => (
            <span
              className="flex items-center gap-1 text-xs text-muted-foreground"
              key={project}
            >
              <FolderIcon className="size-3 shrink-0" />
              <span className="truncate">{project}</span>
            </span>
          ))}
          <TokenUsage
            className="ml-auto shrink-0 text-xs font-medium"
            cost={summary.usage.cost}
            emptyLabel="No usage yet"
            tokens={summary.usage.tokens}
          />
        </div>
      </header>

      <div className="flex flex-col gap-3 pt-3">
        <Section
          icon={BotIcon}
          title={
            summary.workflows.length > 0
              ? `Agents · ${agents.length} across ${summary.workflows.length} workflow${
                  summary.workflows.length === 1 ? "" : "s"
                }`
              : "Agent"
          }
        >
          <div className="flex flex-col gap-1">
            {agents.map((agent, index) => (
              // Index in the key: two agents in one run can share a label
              // (parallel() over a list gives every branch the same one), so
              // the label alone is not unique.
              <AgentRow agent={agent} key={`${agent.label}-${index}`} />
            ))}
          </div>
        </Section>

        <Section icon={SparklesIcon} title="Produced">
          <ArtifactCounts onOpenArtifact={onOpenArtifact} summary={summary} />
        </Section>

        <Section icon={BookOpenIcon} title="Wiki">
          {hasWikiActivity(wiki) ? (
            <div className="flex flex-col gap-0.5">
              <WikiRow
                label="Surfaced into context"
                pages={wiki.recalled}
                title="Auto-recall put these in front of the model — offered, not necessarily used."
              />
              <WikiRow
                label="Opened"
                pages={wiki.read}
                title="Pages the agent chose to read."
              />
              <WikiRow
                label="Written"
                pages={wiki.written}
                title="Pages and observations this session created."
              />
            </div>
          ) : (
            <span className="text-xs text-muted-foreground">No wiki activity.</span>
          )}
        </Section>

        {summary.workflows.length > 0 && (
          <Section icon={PencilLineIcon} title="Workflows">
            <div className="flex flex-col gap-1">
              {summary.workflows.map((run) => (
                <div className="flex items-center gap-1.5 text-xs" key={run.runId}>
                  <span className="truncate font-medium">{run.name}</span>
                  <span className="shrink-0 text-muted-foreground">
                    {run.agents.length} agent{run.agents.length === 1 ? "" : "s"}
                  </span>
                  <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">
                    {formatCost(run.usage.cost)}
                  </span>
                </div>
              ))}
            </div>
          </Section>
        )}
      </div>
    </div>
  );
}
