/**
 * Turning a set of candidate tools and skills into the subset a turn gets.
 *
 * Kept apart from the extension wiring in `./index.ts` because this is the
 * part with the judgment in it — the question shape, the threshold, the floor,
 * and what happens when Jev does not answer — and it is testable without an
 * `ExtensionAPI`, a session, or a network.
 *
 * ## Why one `noul` per candidate, and not one `choice`
 *
 * `docs/plans/jev-agent-gating.md` §4 proposed a single `choice` question per
 * category, thresholding the returned `probabilities`. Probing the live API
 * showed that cannot work: `choice.probabilities` is normalised over the
 * options, so it ranks them against each other instead of scoring each on its
 * own merits. Two consequences sink it. Adding a candidate lowers every other
 * candidate's score without anything having changed — with sixteen tools,
 * nothing can clear 0.15 unless fewer than seven are plausible. And a
 * candidate can score high purely for being the least irrelevant option: in
 * one probe the `workflow-authoring` skill got 0.96 on a turn about fixing a
 * test, because the only alternative was `supabase`.
 *
 * Asking one independent yes/no per candidate gives scores that mean what the
 * threshold needs them to mean, and it is still one HTTP round trip — sixteen
 * questions cost 1358 input / 303 output tokens and ~450 ms, measured.
 *
 * ## The threshold, and where it came from
 *
 * 0.30, chosen by the operator from four live probes rather than from the
 * docs, which say nothing about calibration:
 *
 *   "What is the capital of France?"         every candidate 0.02–0.04
 *   "screenshot the app, does it render?"    mcp 0.89, ask_user 0.69, bash 0.41
 *   "fan a review out across reviewers"      workflow 0.71, read 0.69
 *   "explain how session-service.ts works"   read 0.88, bash 0.69, code_map 0.55
 *
 * The first row is the reason {@link ALWAYS_ON_TOOLS} is not merely a safety
 * net. On a conversational turn Jev correctly reports that no tool is needed,
 * so *every* candidate falls below any sane threshold and the floor is the
 * normal outcome, not a degraded one.
 */

import {
  askJev,
  JevError,
  noulQuestion,
  type JevDecisionRequest,
  type JevDecisionResult,
  type JevQuestion,
} from "@/lib/pi/runtime/jev-client";

/** Probability at or above which a candidate is kept. See the docblock. */
export const DEFAULT_JEV_THRESHOLD = 0.3;

/**
 * Tools Jev can never remove.
 *
 * A gate that can leave the agent unable to read a file or ask a question has
 * failed at being a gate. `read` and `ask_user` are the two moves that are
 * always legitimate: look before acting, and ask when the answer is not
 * available. Deliberately shorter than {@link MINIMAL_SAFE_TOOLS} — this is
 * the floor under a *working* decision, not the fallback for a broken one.
 */
export const ALWAYS_ON_TOOLS: readonly string[] = ["read", "ask_user"];

/**
 * The fail-closed set, used when there is no usable decision.
 *
 * Operator-reviewed (plan §6 left it open). Wider than
 * {@link ALWAYS_ON_TOOLS} because this is not a claim that the turn needs
 * little — it is an admission that nothing here knows what the turn needs, so
 * the agent keeps enough to investigate and to report the problem, and loses
 * the tools that write, delegate, or reach the network.
 *
 * Fail *closed* is the opposite of `read-router.ts`, which fails open. The
 * asymmetry is deliberate and is in the plan: an uncompressed tool result is a
 * cost, whereas a filter that reverts to the full set when it breaks is
 * indistinguishable from no filter at all — it would pass every test while
 * gating nothing.
 */
export const MINIMAL_SAFE_TOOLS: readonly string[] = [
  "read",
  "bash",
  "ask_user",
  "workflow_control",
];

/** A tool or skill Jev is being asked about. */
export interface GateCandidate {
  name: string;
  /** One line. The whole description would cost more than it informs. */
  description: string;
}

export interface GateInput {
  /** The user's prompt for this turn. */
  prompt: string;
  tools: readonly GateCandidate[];
  skills: readonly GateCandidate[];
  /** For the `state` object, so Jev knows what kind of repository this is. */
  projectHint?: string;
}

export type GateOutcome = "decided" | "fail-closed" | "unconfigured";

export interface GateDecision {
  outcome: GateOutcome;
  /** Tool names the turn may use, floor included, in candidate order. */
  tools: string[];
  /** Skill names to keep in the system prompt. Empty is a valid answer. */
  skills: string[];
  /** Per-candidate probabilities, for the span and the UI popover. */
  toolScores: Record<string, number>;
  skillScores: Record<string, number>;
  /** Why there is no decision, when `outcome` is not "decided". */
  reason?: string;
  elapsedMs?: number;
  model?: string;
  costUsd?: number;
}

const TOOL_PREFIX = "tool:";
const SKILL_PREFIX = "skill:";

/**
 * Question keys are prefixed rather than namespaced by two separate calls,
 * because the whole point is that tools and skills are decided in one round
 * trip. A tool and a skill can share a name (`workflow` does), so an
 * unprefixed key would silently collide and one would overwrite the other.
 */
function toolKey(name: string): string {
  return `${TOOL_PREFIX}${name}`;
}

function skillKey(name: string): string {
  return `${SKILL_PREFIX}${name}`;
}

export function buildGateRequest(input: GateInput): JevDecisionRequest {
  const questions: Record<string, JevQuestion> = {};

  for (const tool of input.tools) {
    questions[toolKey(tool.name)] = noulQuestion(
      `Will the assistant need the tool \`${tool.name}\` (${tool.description}) to answer this turn?`,
      `The turn cannot be completed well without ${tool.name}`,
      `The turn can be completed without ${tool.name}`,
    );
  }

  for (const skill of input.skills) {
    questions[skillKey(skill.name)] = noulQuestion(
      `Is the skill \`${skill.name}\` (${skill.description}) relevant to this turn?`,
      `The turn is the kind of task ${skill.name} is written for`,
      `The turn is unrelated to ${skill.name}`,
    );
  }

  return {
    // Only what is being asked about, never the whole session — the same
    // discipline read-router.ts's compression prompt follows.
    state: {
      user_prompt: input.prompt,
      ...(input.projectHint ? { project: input.projectHint } : {}),
    },
    questions,
  };
}

function scoreFor(result: JevDecisionResult, key: string): number | undefined {
  const answer = result.answers[key];
  if (!answer || answer.type !== "noul") return undefined;
  return answer.noul;
}

/**
 * Read a live result into a decision.
 *
 * An unanswered candidate scores 0 and is dropped rather than kept. Keeping it
 * would mean a Jev response that silently omitted half its answers produced a
 * fuller tool set than one that answered them — failing open through the back
 * door.
 */
export function interpretGateResult(
  input: GateInput,
  result: JevDecisionResult,
  threshold: number = DEFAULT_JEV_THRESHOLD,
): GateDecision {
  const toolScores: Record<string, number> = {};
  const skillScores: Record<string, number> = {};

  const approvedTools: string[] = [];
  for (const tool of input.tools) {
    const score = scoreFor(result, toolKey(tool.name)) ?? 0;
    toolScores[tool.name] = score;
    if (score >= threshold) approvedTools.push(tool.name);
  }

  const approvedSkills: string[] = [];
  for (const skill of input.skills) {
    const score = scoreFor(result, skillKey(skill.name)) ?? 0;
    skillScores[skill.name] = score;
    if (score >= threshold) approvedSkills.push(skill.name);
  }

  return {
    outcome: "decided",
    tools: withFloor(approvedTools, input.tools),
    skills: approvedSkills,
    toolScores,
    skillScores,
    elapsedMs: result.elapsedMs,
    ...(result.model ? { model: result.model } : {}),
    ...(result.usage?.cost === undefined ? {} : { costUsd: result.usage.cost }),
  };
}

/**
 * Add the always-on floor, but only for tools this session actually has.
 *
 * `setActiveTools` is given names; a name the session never registered is at
 * best ignored and at worst an error, and the floor must not be the thing that
 * breaks a session configured without `ask_user`.
 */
function withFloor(approved: readonly string[], candidates: readonly GateCandidate[]): string[] {
  const available = new Set(candidates.map((c) => c.name));
  const out = [...approved];
  for (const name of ALWAYS_ON_TOOLS) {
    if (available.has(name) && !out.includes(name)) out.push(name);
  }
  return out;
}

/** The fail-closed decision, intersected with what the session really has. */
export function failClosedDecision(
  input: GateInput,
  reason: string,
): GateDecision {
  const available = new Set(input.tools.map((c) => c.name));
  return {
    outcome: "fail-closed",
    tools: MINIMAL_SAFE_TOOLS.filter((name) => available.has(name)),
    // No decision means no basis for narrowing the prompt either; the skills
    // section is left exactly as Pi assembled it. Dropping every skill would
    // be a silent, invisible change to the agent's instructions, which §5 of
    // the plan singles out as the failure mode worth avoiding here.
    skills: input.skills.map((s) => s.name),
    toolScores: {},
    skillScores: {},
    reason,
  };
}

export interface DecideGateOptions {
  threshold?: number;
  timeoutMs?: number;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

/**
 * Ask Jev, and return a decision either way. Never throws.
 *
 * Absent credentials are reported as `unconfigured`, not as a failure. That is
 * the one case where fail-closed would be wrong: a host with no OpenRouter key
 * has not got a broken gate, it has no gate, and collapsing every session on
 * such a host to four tools would be a filter nobody asked for. It matches how
 * `code-index/credentials.ts` treats the same absence — an optional capability
 * that no-ops rather than an error. Every other failure fails closed.
 */
export async function decideGate(
  input: GateInput,
  options: DecideGateOptions = {},
): Promise<GateDecision> {
  try {
    const result = await askJev(buildGateRequest(input), {
      ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    return interpretGateResult(input, result, options.threshold ?? DEFAULT_JEV_THRESHOLD);
  } catch (error) {
    if (error instanceof JevError && error.reason === "no-credentials") {
      return {
        outcome: "unconfigured",
        tools: input.tools.map((c) => c.name),
        skills: input.skills.map((c) => c.name),
        toolScores: {},
        skillScores: {},
        reason: error.message,
      };
    }
    const reason =
      error instanceof JevError
        ? `${error.reason}: ${error.message}`
        : error instanceof Error
          ? error.message
          : String(error);
    return failClosedDecision(input, reason);
  }
}
