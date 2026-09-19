/**
 * Narrowing a turn's tools and skills to what Jev thinks it needs.
 *
 * `docs/plans/jev-agent-gating.md`, phases 2 and 3. The judgment lives in
 * `./gate-decision.ts` and `./skills-prompt.ts`; this file is the wiring, and
 * the wiring is where the SDK's constraints show up.
 *
 * ## Three hooks, doing three different things
 *
 *  - `before_agent_start` is the primary one. It is the only hook handed the
 *    assembled `systemPrompt` with a chance to replace it, so it is the only
 *    place skills can be filtered at all; it is also the first place the
 *    prompt text exists, so the turn's tools are decided here too. It fires
 *    once per user prompt, which means skill gating is re-decided per prompt
 *    rather than per model turn. That is an SDK limit, not a choice — there is
 *    no intra-loop skill API — and the plan records it as such.
 *  - `turn_start` is *not* the primary hook, though plan §4 proposed it:
 *    `TurnStartEvent` carries only `turnIndex` and `timestamp`, so there is no
 *    prompt to ask Jev about. It re-asserts the standing decision instead,
 *    because a turn boundary is where something else may have called
 *    `setActiveTools` — `workflow.ts` does exactly that around its own calls.
 *  - `tool_result` re-evaluates mid-turn, gated on a hash of the conversation
 *    so far, so a long turn that has moved on does not keep the tool set it
 *    opened with, and a short one does not pay for a second call.
 *
 * ## Fail closed, and why that is not symmetric with read-router
 *
 * Any failure to get a decision leaves the agent with `MINIMAL_SAFE_TOOLS`.
 * `read-router.ts` fails open in the same situation and is right to: an
 * uncompressed tool result costs context and nothing else. A filter that
 * reverts to the full set when it breaks is a different matter — it is
 * indistinguishable from having no filter, it would pass every test, and it
 * would gate nothing. Absent credentials are the one exception, decided in
 * `decideGate`: a host with no OpenRouter key has no gate rather than a broken
 * one, and collapsing it to four tools would be a filter nobody configured.
 *
 * ## What it records, and why twice
 *
 * A `jev_gate.decision` span for cost, latency and outcome, and a
 * `custom_message` entry for the conversation view (§8). A span is not
 * readable beside the prompt it applied to, and a conversation entry does not
 * belong in a waterfall, so "why did this turn not have tool X" needs both.
 */

import { createHash } from "node:crypto";

import type {
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionContext,
  Skill,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";

import { getSpanSink } from "@/lib/pi/telemetry/sink-registry";
import { loadWorkflowSettings } from "../dynamic-workflows/src/workflow-settings";
import {
  decideGate,
  DEFAULT_JEV_THRESHOLD,
  MINIMAL_SAFE_TOOLS,
  type GateCandidate,
  type GateDecision,
} from "./gate-decision";
import { JEV_GATE_CUSTOM_TYPE, type JevGateRecord } from "./gate-record";
import { rewriteSkillsSection } from "./skills-prompt";

/**
 * The coarse MCP axis. Plan §2 settles on gating the gateway tools themselves
 * rather than individual servers, because the adapter exposes no per-server
 * toggle and rewriting `mcp.json` only takes effect at session bind — which
 * cannot satisfy the mid-turn requirement. Recorded on the decision as
 * `mcpAllowed` so the "sources" axis is visible even though it is all-or-nothing.
 */
export const MCP_GATEWAY_TOOLS = ["mcp", "mcpScript", "mcp__brave_devtools"];

/** Default deadline for the decision call. */
const DEFAULT_TIMEOUT_MS = 2000;

/**
 * Tool results after which a re-evaluation is worth its cost.
 *
 * Every tool result would mean a Jev call per `read`, which is most of them.
 * These are the ones that change what the turn is *about*: a search or a
 * workflow result routinely redirects the work, whereas a `write` confirms
 * something already decided.
 */
const REEVALUATE_AFTER = new Set([
  "bash",
  "code_search",
  "workflow",
  "wiki_recall",
  "ask_user",
]);

/** A description long enough to judge on, short enough not to dominate state. */
function summarise(description: string | undefined): string {
  const text = (description ?? "").trim().replace(/\s+/g, " ");
  if (!text) return "no description";
  const firstSentence = text.split(/(?<=\.)\s/)[0] ?? text;
  return firstSentence.length > 200 ? `${firstSentence.slice(0, 197)}…` : firstSentence;
}

function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

export default function jevGateExtension(pi: ExtensionAPI): void {
  /**
   * Session-scoped state. An extension instance is created per session, the
   * same lifetime `read-router.ts`'s cache has.
   */
  let standing: GateDecision | null = null;
  let prompt = "";
  let lastEvaluatedHash = "";
  let evaluations = 0;
  /** The full discovered skill list, needed to rebuild the prompt block. */
  let discoveredSkills: readonly Skill[] = [];

  let warned = false;
  const warnOnce = (reason: string) => {
    if (warned) return;
    warned = true;
    console.warn(
      `[jev-gate] no decision available: ${reason}. ` +
        `Falling back to the minimal safe tool set (${MINIMAL_SAFE_TOOLS.join(", ")}).`,
    );
  };

  const readSettings = (ctx: ExtensionContext) => {
    const settings = loadWorkflowSettings({ cwd: ctx.cwd });
    return {
      // Default OFF, reversing the earlier decision. Live use on this very
      // repository's own session narrowed the operator's own tools mid-
      // conversation — correct behaviour, but disruptive to be on by default
      // before the threshold and floor have a track record. `true` must now
      // be explicit, the same way read-router.ts requires `false` to be.
      enabled: settings.jevGateEnabled === true,
      threshold: settings.jevGateThreshold ?? DEFAULT_JEV_THRESHOLD,
      timeoutMs: settings.jevGateTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    };
  };

  /**
   * Everything the session could offer.
   *
   * `getAllTools`, never `getActiveTools`: the candidate set has to be the
   * full registry, or a tool this extension narrowed away on one turn would
   * never be a candidate again on the next — the gate would ratchet shut.
   */
  const toolCandidates = (): GateCandidate[] =>
    pi.getAllTools().map((tool) => ({
      name: tool.name,
      description: summarise(tool.description),
    }));

  const skillCandidates = (): GateCandidate[] =>
    discoveredSkills
      // A disableModelInvocation skill is not in the prompt to begin with, so
      // asking about it would spend a question on something unremovable.
      .filter((skill) => !skill.disableModelInvocation)
      .map((skill) => ({ name: skill.name, description: summarise(skill.description) }));

  const buildRecord = (
    decision: GateDecision,
    tools: readonly GateCandidate[],
    skills: readonly GateCandidate[],
    threshold: number,
    index: number,
  ): JevGateRecord => {
    const keptTools = new Set(decision.tools);
    const keptSkills = new Set(decision.skills);
    return {
      droppedSkills: skills.map((s) => s.name).filter((n) => !keptSkills.has(n)),
      droppedTools: tools.map((t) => t.name).filter((n) => !keptTools.has(n)),
      evaluation: index,
      mcpAllowed: decision.tools.some((name) => MCP_GATEWAY_TOOLS.includes(name)),
      outcome: decision.outcome,
      skills: decision.skills,
      skillScores: decision.skillScores,
      threshold,
      tools: decision.tools,
      toolScores: decision.toolScores,
      ...(decision.costUsd === undefined ? {} : { costUsd: decision.costUsd }),
      ...(decision.elapsedMs === undefined ? {} : { elapsedMs: decision.elapsedMs }),
      ...(decision.model === undefined ? {} : { model: decision.model }),
      ...(decision.reason === undefined ? {} : { reason: decision.reason }),
    };
  };

  const record = (ctx: ExtensionContext, entry: JevGateRecord) => {
    const sink = getSpanSink(ctx.sessionManager.getSessionId());
    if (sink) {
      const span = sink.openSpan({ name: "jev_gate.decision" });
      span.setAttributes({
        droppedSkills: entry.droppedSkills.join(","),
        droppedTools: entry.droppedTools.join(","),
        elapsedMs: entry.elapsedMs ?? 0,
        evaluation: entry.evaluation,
        mcpAllowed: entry.mcpAllowed,
        model: entry.model ?? "",
        outcome: entry.outcome,
        reason: entry.reason ?? "",
        skills: entry.skills.join(","),
        threshold: entry.threshold,
        tools: entry.tools.join(","),
        ...(entry.costUsd === undefined ? {} : { costUsd: entry.costUsd }),
      });
      span.close();
    }

    // `display: false` keeps it out of a TUI transcript; Semla's own
    // conversation view reads it deliberately — see wiki-recall-message.ts,
    // where the same flag on the wiki's injection was mistaken for a signal to
    // drop the entry entirely and cost the UI its only record of it.
    pi.sendMessage({
      customType: JEV_GATE_CUSTOM_TYPE,
      content: JSON.stringify(entry),
      display: false,
    });
  };

  /**
   * One evaluation: ask, apply the tool half, remember the rest.
   *
   * The skills half is returned rather than applied, because only
   * `before_agent_start` can act on it — a `systemPrompt` returned from any
   * other hook is discarded.
   */
  const evaluate = async (
    ctx: ExtensionContext,
    userPrompt: string,
  ): Promise<GateDecision | null> => {
    const { enabled, threshold, timeoutMs } = readSettings(ctx);
    if (!enabled) return null;

    const tools = toolCandidates();
    const skills = skillCandidates();
    if (tools.length === 0) return null;

    const decision = await decideGate(
      {
        prompt: userPrompt,
        tools,
        skills,
        projectHint: ctx.cwd,
      },
      { threshold, timeoutMs, ...(ctx.signal ? { signal: ctx.signal } : {}) },
    );

    evaluations += 1;
    standing = decision;

    if (decision.outcome === "unconfigured") {
      // No key: the gate is absent, not broken. Leave the session's tools
      // exactly as they were and record why, so a session with no filtering
      // says so rather than looking like one that decided to filter nothing.
      record(ctx, buildRecord(decision, tools, skills, threshold, evaluations));
      return decision;
    }

    if (decision.outcome === "fail-closed") warnOnce(decision.reason ?? "unknown");

    pi.setActiveTools(decision.tools);
    record(ctx, buildRecord(decision, tools, skills, threshold, evaluations));
    return decision;
  };

  pi.on("before_agent_start", async (event: BeforeAgentStartEvent, ctx: ExtensionContext) => {
    prompt = event.prompt;
    lastEvaluatedHash = contentHash(event.prompt);

    // The only source of the skill list. `resources_discover` looks like the
    // natural place to capture it and is not: ResourcesDiscoverEvent carries
    // `cwd` and `reason` only, and its result *adds* skill paths rather than
    // reporting what was loaded. `systemPromptOptions.skills` is what Pi built
    // this very prompt from, which is exactly the list the rewrite must edit —
    // re-discovering would risk operating on a set that is not in the text.
    const fromOptions = event.systemPromptOptions.skills;
    if (fromOptions?.length) discoveredSkills = fromOptions;

    const decision = await evaluate(ctx, event.prompt);
    if (!decision || decision.outcome !== "decided") return;
    if (discoveredSkills.length === 0) return;

    const rewrite = rewriteSkillsSection(event.systemPrompt, discoveredSkills, decision.skills);
    if (!rewrite.rewritten) return;
    return { systemPrompt: rewrite.systemPrompt };
  });

  pi.on("turn_start", (_event, _ctx: ExtensionContext) => {
    // No prompt on this event, so no new decision is possible here. Re-assert
    // the standing one: other extensions add tools around their own calls and
    // restore what was active at the time, which can reinstate a tool this
    // gate removed.
    if (!standing || standing.outcome === "unconfigured") return;
    const active = pi.getActiveTools();
    const expected = standing.tools;
    const drifted =
      active.length !== expected.length || expected.some((name) => !active.includes(name));
    if (drifted) pi.setActiveTools(expected);
  });

  pi.on("tool_result", async (event: ToolResultEvent, ctx: ExtensionContext) => {
    if (!REEVALUATE_AFTER.has(event.toolName)) return;
    if (!prompt) return;

    // Hash-gated on the prompt plus what has happened since, so a turn that
    // has genuinely moved on is re-decided and a repetitive one is not. Same
    // caching idea as read-router.ts, for the same reason: the call is cheap
    // but not free, and a decision per tool result would dominate the turn.
    const hash = contentHash(`${prompt}\u0000${event.toolName}\u0000${extractText(event.content)}`);
    if (hash === lastEvaluatedHash) return;
    lastEvaluatedHash = hash;

    await evaluate(ctx, prompt);
    // Returning nothing: this hook can rewrite a tool result, and must not.
    // The gate's business is what the agent may call next, never what a tool
    // said — read-router.ts owns that hook's rewrite and the two would fight.
    return;
  });

  pi.on("session_shutdown", () => {
    if (evaluations === 0) return;
    const last = standing;
    console.info(
      `[jev-gate] ${evaluations} decision(s); last outcome ${last?.outcome ?? "none"}` +
        (last?.outcome === "decided" ? `, ${last.tools.length} tool(s) active` : ""),
    );
  });
}

/** Text blocks of a tool result, ignoring images. */
function extractText(content: Array<unknown>): string {
  return (content as Array<{ type: string; text?: string }>)
    .filter((part): part is { type: "text"; text: string } =>
      part.type === "text" && typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("\n");
}
