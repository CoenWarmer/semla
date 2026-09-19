/**
 * Tests for the gate's decision logic, which is where the plan's §7
 * verifiability requirements land.
 *
 * The fail-closed cases are the point. A filter that reverts to the full set
 * on failure is indistinguishable from no filter, so "the error path narrows
 * rather than widens" is the property that has to be nailed down — if it
 * regresses, everything still works and nothing is gated.
 *
 * `noulResponse` builds bodies in the shape the live API returned; the shape
 * itself is pinned by `runtime/jev-client.test.ts` against a recorded response,
 * so these tests are free to synthesise probabilities.
 */

import { describe, expect, it, vi } from "vitest";

import {
  ALWAYS_ON_TOOLS,
  buildGateRequest,
  decideGate,
  DEFAULT_JEV_THRESHOLD,
  failClosedDecision,
  interpretGateResult,
  MINIMAL_SAFE_TOOLS,
  type GateInput,
} from "./gate-decision";
import type { JevDecisionResult } from "@/lib/pi/runtime/jev-client";

// Includes every ALWAYS_ON_TOOLS member, so a session that has registered a
// normal tool set is what these fixtures represent, and the floor tests below
// exercise the floor being *added*, not the intersection-with-availability
// fallback that a real gap in the fixture would otherwise trigger silently.
const TOOLS = [
  { name: "read", description: "Read a file" },
  { name: "bash", description: "Run a command" },
  { name: "edit", description: "Edit a file with exact text replacement" },
  { name: "write", description: "Write a file" },
  { name: "code_search", description: "Search the project's code index by meaning" },
  { name: "wiki_recall", description: "Search the wiki for pages relevant to a query" },
  { name: "wiki_search", description: "Search the wiki registry for pages" },
  { name: "workflow", description: "Delegate to subagents" },
  { name: "ask_user", description: "Ask the user" },
  { name: "workflow_control", description: "Manage workflow runs" },
  { name: "mcp", description: "MCP gateway" },
];

const SKILLS = [
  { name: "supabase", description: "Supabase tasks" },
  { name: "workflow-authoring", description: "Writing workflow scripts" },
];

const INPUT: GateInput = { prompt: "fix the failing test", tools: TOOLS, skills: SKILLS };

function result(scores: Record<string, number>): JevDecisionResult {
  return {
    answers: Object.fromEntries(
      Object.entries(scores).map(([key, noul]) => [key, { type: "noul" as const, noul }]),
    ),
    elapsedMs: 400,
    model: "typesafe/jev-1.13-20260917",
    usage: { inputTokens: 1358, outputTokens: 303, cost: 0.000057 },
  };
}

function httpResponse(scores: Record<string, number>): Response {
  return new Response(
    JSON.stringify({
      model: "typesafe/jev-1.13-20260917",
      answers: Object.fromEntries(
        Object.entries(scores).map(([k, noul]) => [k, { type: "noul", noul }]),
      ),
      usage: { input_tokens: 10, output_tokens: 5, cost: 0.00001 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("buildGateRequest", () => {
  it("asks one independent noul per candidate, in one request", () => {
    const request = buildGateRequest(INPUT);
    expect(Object.keys(request.questions)).toHaveLength(TOOLS.length + SKILLS.length);
    for (const question of Object.values(request.questions)) {
      expect(question.type).toBe("noul");
      expect(Object.keys(question.criteria as Record<string, string>).sort()).toEqual([
        "false",
        "true",
      ]);
    }
  });

  it("never asks a choice question, because its probabilities are normalised", () => {
    // Plan §4 proposed exactly this and it cannot express multi-select; see
    // the module docblock. Asserted so a future edit does not reintroduce it.
    const request = buildGateRequest(INPUT);
    expect(Object.values(request.questions).some((q) => q.type === "choice")).toBe(false);
  });

  it("prefixes keys so a tool and a skill of the same name cannot collide", () => {
    const request = buildGateRequest({
      prompt: "p",
      tools: [{ name: "workflow", description: "the tool" }],
      skills: [{ name: "workflow", description: "the skill" }],
    });
    expect(Object.keys(request.questions).sort()).toEqual(["skill:workflow", "tool:workflow"]);
  });

  it("sends only the prompt and a project hint as state, not the session", () => {
    const request = buildGateRequest({ ...INPUT, projectHint: "/repo" });
    expect(request.state).toEqual({ user_prompt: "fix the failing test", project: "/repo" });
  });
});

describe("interpretGateResult", () => {
  it("keeps candidates at or above the threshold and drops the rest", () => {
    const decision = interpretGateResult(
      INPUT,
      result({
        "tool:read": 0.94,
        "tool:bash": 0.84,
        "tool:write": 0.3,
        "tool:workflow": 0.15,
        "tool:ask_user": 0.46,
        "tool:workflow_control": 0.09,
        "tool:mcp": 0.32,
        "skill:supabase": 0.04,
        "skill:workflow-authoring": 0.61,
      }),
    );

    expect(decision.outcome).toBe("decided");
    // 0.3 is kept: the threshold is inclusive, so a candidate exactly on it is
    // not decided by floating-point luck.
    expect(decision.tools).toContain("write");
    expect(decision.tools).not.toContain("workflow");
    expect(decision.tools).not.toContain("workflow_control");
    expect(decision.skills).toEqual(["workflow-authoring"]);
  });

  it("reports every candidate's score, including the dropped ones", () => {
    const decision = interpretGateResult(INPUT, result({ "tool:read": 0.9 }));
    expect(Object.keys(decision.toolScores).sort()).toEqual(TOOLS.map((t) => t.name).sort());
    expect(decision.toolScores.workflow).toBe(0);
  });

  it("drops an unanswered candidate rather than keeping it", () => {
    // Keeping it would mean a truncated response produced a *wider* tool set
    // than a complete one — failing open through the back door.
    const decision = interpretGateResult(INPUT, result({ "tool:read": 0.9 }));
    expect(decision.tools).not.toContain("bash");
  });

  it("adds the always-on floor even when every score is near zero", () => {
    // The "capital of France" case: Jev correctly says no tool is needed, so
    // the floor is the normal outcome for a conversational turn.
    const decision = interpretGateResult(
      INPUT,
      result(Object.fromEntries(TOOLS.map((t) => [`tool:${t.name}`, 0.02]))),
    );
    expect(decision.tools).toEqual([...ALWAYS_ON_TOOLS]);
  });

  it("does not add a floor tool the session never registered", () => {
    const decision = interpretGateResult(
      { prompt: "p", tools: [{ name: "read", description: "r" }], skills: [] },
      result({ "tool:read": 0.01 }),
    );
    expect(decision.tools).toEqual(["read"]);
    expect(decision.tools).not.toContain("ask_user");
  });

  it("carries latency, model and cost through for the span", () => {
    const decision = interpretGateResult(INPUT, result({ "tool:read": 0.9 }));
    expect(decision.elapsedMs).toBe(400);
    expect(decision.model).toBe("typesafe/jev-1.13-20260917");
    expect(decision.costUsd).toBe(0.000057);
  });

  it("ignores a choice answer where a noul was asked", () => {
    const hybrid: JevDecisionResult = {
      answers: {
        "tool:read": { type: "choice", choice: "read", probabilities: { read: 1 } },
      },
      elapsedMs: 1,
    };
    const decision = interpretGateResult(INPUT, hybrid);
    expect(decision.toolScores.read).toBe(0);
  });
});

describe("fail-closed behaviour", () => {
  it("narrows to MINIMAL_SAFE_TOOLS, not to the previous or full set", () => {
    const decision = failClosedDecision(INPUT, "timeout");
    expect(decision.outcome).toBe("fail-closed");
    expect(decision.tools).toEqual([...MINIMAL_SAFE_TOOLS]);
    expect(decision.tools).not.toContain("write");
    expect(decision.tools).not.toContain("workflow");
    expect(decision.tools).not.toContain("mcp");
    expect(decision.reason).toBe("timeout");
  });

  it("leaves the skills section alone when there is no decision", () => {
    // A missing tool is loud; a silently narrowed system prompt is not. With
    // no basis for narrowing, the prompt stays as Pi assembled it.
    const decision = failClosedDecision(INPUT, "timeout");
    expect(decision.skills).toEqual(SKILLS.map((s) => s.name));
  });

  it("intersects the safe set with what the session actually has", () => {
    const decision = failClosedDecision(
      { prompt: "p", tools: [{ name: "read", description: "r" }], skills: [] },
      "http-error",
    );
    expect(decision.tools).toEqual(["read"]);
  });

  it("fails closed on a timeout", async () => {
    const fetchImpl = ((_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      })) as unknown as typeof fetch;

    const decision = await decideGate(INPUT, { apiKey: "k", fetchImpl, timeoutMs: 5 });
    expect(decision.outcome).toBe("fail-closed");
    expect(decision.tools).toEqual([...MINIMAL_SAFE_TOOLS]);
  });

  it("fails closed on an HTTP error", async () => {
    const decision = await decideGate(INPUT, {
      apiKey: "k",
      fetchImpl: (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch,
    });
    expect(decision.outcome).toBe("fail-closed");
    expect(decision.tools).toEqual([...MINIMAL_SAFE_TOOLS]);
    expect(decision.reason).toContain("http-error");
  });

  it("fails closed on an unparseable body", async () => {
    const decision = await decideGate(INPUT, {
      apiKey: "k",
      fetchImpl: (async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch,
    });
    expect(decision.outcome).toBe("fail-closed");
    expect(decision.tools).toEqual([...MINIMAL_SAFE_TOOLS]);
  });

  it("never throws, whatever the transport does", async () => {
    const decision = await decideGate(INPUT, {
      apiKey: "k",
      fetchImpl: (() => {
        throw new TypeError("boom");
      }) as unknown as typeof fetch,
    });
    expect(decision.outcome).toBe("fail-closed");
  });
});

describe("decideGate with no credentials", () => {
  it("reports unconfigured and changes nothing", async () => {
    // The one case where fail-closed would be wrong: a host with no key has no
    // gate, not a broken one, and must not be collapsed to four tools.
    const fetchImpl = vi.fn();
    const decision = await decideGate(INPUT, {
      apiKey: "",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(decision.outcome).toBe("unconfigured");
    expect(decision.tools).toEqual(TOOLS.map((t) => t.name));
    expect(decision.skills).toEqual(SKILLS.map((s) => s.name));
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("decideGate end to end", () => {
  it("uses the configured threshold", async () => {
    const scores = Object.fromEntries(TOOLS.map((t) => [`tool:${t.name}`, 0.4]));
    const permissive = await decideGate(INPUT, {
      apiKey: "k",
      threshold: 0.2,
      fetchImpl: (async () => httpResponse(scores)) as unknown as typeof fetch,
    });
    const strict = await decideGate(INPUT, {
      apiKey: "k",
      threshold: 0.8,
      fetchImpl: (async () => httpResponse(scores)) as unknown as typeof fetch,
    });

    expect(permissive.tools).toHaveLength(TOOLS.length);
    expect(strict.tools).toEqual([...ALWAYS_ON_TOOLS]);
  });

  it("defaults to the calibrated threshold", () => {
    expect(DEFAULT_JEV_THRESHOLD).toBe(0.3);
  });
});
