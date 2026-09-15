/**
 * Folding workflow subagents' reads into a session's timeline.
 *
 * Read from each subagent's own transcript, not from the run file. A run file's
 * per-agent `history` is compacted to 40 entries / 20 000 chars and only
 * promotes `path` for `write` and `edit` — a `read` survives as a JSON blob
 * inside a text field, and a `bash` read not at all. Parsing that back would be
 * a second, weaker extractor disagreeing with the first. The transcripts are
 * ordinary pi session files, so the same extractor reads them.
 *
 * Attribution is by time. A subagent's work belongs to the turn that started
 * the workflow, and the run index records when the run was created, so the turn
 * is the last one to have begun before it. Reading the run id back out of the
 * workflow tool result would be more direct but couples this to the workflow
 * extension's result shape, which this module otherwise knows nothing about.
 */

import { PI_SESSION_DIR } from "@/lib/pi/runtime-config";
import { readSessionEntriesFromPath } from "@/lib/pi/session-file";
import { ROOT_TURN_ID } from "@/lib/pi/session-turn-graph";
import {
  indexAgentTranscripts,
  subagentSessionName,
} from "@/lib/pi/workflow-agent-transcript";
import { listWorkflowRuns } from "@/lib/pi/workflow-run-index";
import { snapshotFromRunFile } from "@/lib/pi/workflow-service";

import { existenceCache } from "./access-paths";
import {
  accessesFromEntries,
  workspaceForSession,
  type TimelineOptions,
} from "./access-timeline";
import type {
  AccessAgent,
  FileAccessTimeline,
  ToolCallStep,
  TimelineTurn,
} from "./access-types";

/** The turn a run belongs to: the last one that had started when it began. */
export function turnForRun(
  turns: readonly TimelineTurn[],
  createdAt: string | null | undefined,
): string {
  if (!createdAt) return turns[turns.length - 1]?.id ?? ROOT_TURN_ID;

  let found = ROOT_TURN_ID;
  for (const turn of turns) {
    // An entry that carried no timestamp is skipped, not treated as the end of
    // the scan: one undated turn early in a session must not orphan every
    // subagent that ran after it.
    if (!turn.at) continue;
    if (turn.at > createdAt) break;
    found = turn.id;
  }

  return found;
}

/**
 * The same timeline, with every subagent's tool calls merged in chronologically.
 *
 * Returned unchanged when the session ran no workflows, which is the common
 * case and costs one index read.
 */
export function withSubagentAccesses(
  sessionId: string,
  timeline: FileAccessTimeline,
  options: TimelineOptions = {},
): FileAccessTimeline {
  const runs = listWorkflowRuns(sessionId);
  if (runs.length === 0) return timeline;

  const dir = options.dir ?? PI_SESSION_DIR;
  const workspace = workspaceForSession(sessionId, dir, options.workspaceRoot);
  const exists = options.exists ?? existenceCache();
  const transcripts = indexAgentTranscripts(dir);

  const added: ToolCallStep[] = [];
  const agents: AccessAgent[] = [...timeline.agents];

  for (const run of runs) {
    const snapshot = snapshotFromRunFile(run.run_id);
    if (!snapshot) continue;

    const turnId = turnForRun(timeline.turns, run.created_at);

    for (const agent of snapshot.agents) {
      const path = transcripts.get(subagentSessionName(run.run_id, agent.label));
      // No transcript is an ordinary outcome, not a failure: a run from before
      // subagent persistence existed, or one whose session directory was not
      // writable and fell back to in-memory. The agent still appears in the
      // filter, showing nothing rather than implying it read nothing.
      if (!path) continue;

      const entries = readSessionEntriesFromPath(path);
      if (!entries) continue;

      const identity: AccessAgent = {
        id: `${run.run_id}:${agent.id}`,
        label: agent.label,
      };

      const { calls } = accessesFromEntries(entries, {
        agent: identity,
        exists,
        fixedTurnId: turnId,
        workspace,
      });

      // A subagent with zero calls at all is an empty transcript, not one that
      // merely touched no file — the latter still belongs in "All tools".
      if (calls.length === 0) continue;

      agents.push(identity);
      added.push(...calls);
    }
  }

  if (added.length === 0) return timeline;

  return {
    agents,
    calls: [...timeline.calls, ...added].sort((a, b) => a.at.localeCompare(b.at)),
    turns: timeline.turns,
  };
}
