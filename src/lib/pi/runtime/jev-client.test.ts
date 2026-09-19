/**
 * Contract test for the Decisions API client.
 *
 * `RECORDED_RESPONSE` is a real body, captured on 2026-09-19 by
 * `scripts/probe-jev.mjs`. It is the point of this file: the endpoint is alpha
 * and undocumented in the parts that matter, so the only thing keeping the
 * parser honest is a response nobody hand-wrote. If a future version of the
 * API changes shape, this fails with a diff against what was actually served
 * rather than against what the plan assumed.
 *
 * The `yes`/`no` case is likewise not hypothetical — it is the 400 the first
 * live probe got, kept so `noulQuestion` cannot quietly stop being used.
 */

import { describe, expect, it, vi } from "vitest";

import {
  askJev,
  JevError,
  JEV_DECISIONS_URL,
  JEV_MODEL,
  noulQuestion,
} from "./jev-client";

/** Verbatim from a live 200, with all three answer types present. */
const RECORDED_RESPONSE = {
  model: "typesafe/jev-1.13-20260917",
  answers: {
    tools: {
      type: "choice",
      choice: "read",
      probabilities: {
        workflow: 0,
        bash: 0.31,
        capture_feature_spec: 0,
        read: 0.69,
        wiki_capture_source: 0,
      },
      confidence: 0.61,
    },
    needs_mcp: { type: "noul", noul: 0.11 },
    complexity: {
      type: "score",
      score: 1.21,
      legend: { "0": "trivial", "1": "small", "2": "medium", "3": "large" },
      probabilities: { "0": 0.06, "1": 0.67, "2": 0.26, "3": 0.01 },
      confidence: 0.67,
    },
  },
  usage: { input_tokens: 690, output_tokens: 125, cost: 0.00002898 },
  id: "gen-dec-1789824059-i9iI1viNxdRLQnxBjMRE",
  provider: "TypeSafe",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("askJev request shape", () => {
  it("posts model, state and questions to the decisions endpoint", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(RECORDED_RESPONSE));

    await askJev(
      {
        state: { user_prompt: "fix the test" },
        questions: { needs_mcp: noulQuestion("needs mcp?", "yes it does", "no it does not") },
      },
      { apiKey: "test-key", fetchImpl: fetchImpl as unknown as typeof fetch },
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(JEV_DECISIONS_URL);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer test-key");

    const sent = JSON.parse(init.body as string);
    expect(sent.model).toBe(JEV_MODEL);
    expect(sent.state).toEqual({ user_prompt: "fix the test" });
    expect(Object.keys(sent.questions)).toEqual(["needs_mcp"]);
  });

  it("keys noul criteria true/false, which the live API requires", () => {
    // `yes`/`no` returns HTTP 400 with a zod invalid_union at
    // questions.<key>.criteria.yes. Observed, not inferred.
    const question = noulQuestion("does this turn need mcp?", "it does", "it does not");
    expect(question.type).toBe("noul");
    expect(Object.keys(question.criteria as Record<string, string>).sort()).toEqual([
      "false",
      "true",
    ]);
  });

  it("sends every candidate in one request rather than one call each", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(RECORDED_RESPONSE));
    const questions = Object.fromEntries(
      ["read", "bash", "edit", "write"].map((name) => [
        `tool_${name}`,
        noulQuestion(`needs ${name}?`, "needed", "not needed"),
      ]),
    );

    await askJev(
      { state: "prompt", questions },
      { apiKey: "k", fetchImpl: fetchImpl as unknown as typeof fetch },
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(
      (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string,
    );
    expect(Object.keys(sent.questions)).toHaveLength(4);
  });
});

describe("askJev response parsing", () => {
  it("parses all three answer types from a recorded live response", async () => {
    const result = await askJev(
      { state: "s", questions: {} },
      {
        apiKey: "k",
        fetchImpl: (async () => jsonResponse(RECORDED_RESPONSE)) as unknown as typeof fetch,
      },
    );

    const choice = result.answers.tools;
    expect(choice.type).toBe("choice");
    if (choice.type !== "choice") throw new Error("unreachable");
    expect(choice.choice).toBe("read");
    expect(choice.probabilities.read).toBe(0.69);
    expect(choice.confidence).toBe(0.61);

    const noul = result.answers.needs_mcp;
    expect(noul).toEqual({ type: "noul", noul: 0.11 });

    const score = result.answers.complexity;
    expect(score.type).toBe("score");
    if (score.type !== "score") throw new Error("unreachable");
    expect(score.score).toBe(1.21);
    expect(score.legend).toEqual({ "0": "trivial", "1": "small", "2": "medium", "3": "large" });
    expect(score.confidence).toBe(0.67);
  });

  it("carries usage, resolved model id and generation id through", async () => {
    const result = await askJev(
      { state: "s", questions: {} },
      {
        apiKey: "k",
        fetchImpl: (async () => jsonResponse(RECORDED_RESPONSE)) as unknown as typeof fetch,
      },
    );

    expect(result.model).toBe("typesafe/jev-1.13-20260917");
    expect(result.id).toBe("gen-dec-1789824059-i9iI1viNxdRLQnxBjMRE");
    expect(result.usage).toEqual({ inputTokens: 690, outputTokens: 125, cost: 0.00002898 });
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("records that choice probabilities are a distribution, not relevance", async () => {
    // Why jev-gate asks one noul per candidate instead of thresholding a
    // choice: these sum to 1, so they measure rank among options, and adding
    // an option lowers every other score without anything having changed.
    const result = await askJev(
      { state: "s", questions: {} },
      {
        apiKey: "k",
        fetchImpl: (async () => jsonResponse(RECORDED_RESPONSE)) as unknown as typeof fetch,
      },
    );
    const answer = result.answers.tools;
    if (answer.type !== "choice") throw new Error("unreachable");
    const total = Object.values(answer.probabilities).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 2);
  });
});

describe("askJev failure modes", () => {
  it("throws no-credentials when no key is available", async () => {
    await expect(
      askJev(
        { state: "s", questions: {} },
        {
          apiKey: "",
          // Must not be reached.
          fetchImpl: (() => {
            throw new Error("fetch should not be called without a key");
          }) as unknown as typeof fetch,
        },
      ),
    ).rejects.toMatchObject({ reason: "no-credentials" });
  });

  it("throws http-error with the body, which carries the validation detail", async () => {
    const body = {
      error: { message: '[{"code":"invalid_union","path":["questions","x","criteria","yes"]}]', code: 400 },
    };
    const error = await askJev(
      { state: "s", questions: {} },
      {
        apiKey: "k",
        fetchImpl: (async () => jsonResponse(body, 400)) as unknown as typeof fetch,
      },
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(JevError);
    expect(error).toMatchObject({ reason: "http-error", status: 400 });
    expect((error as JevError).message).toContain("invalid_union");
  });

  it("throws timeout when the call outlives its budget", async () => {
    const fetchImpl = ((_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      })) as unknown as typeof fetch;

    await expect(
      askJev({ state: "s", questions: {} }, { apiKey: "k", fetchImpl, timeoutMs: 5 }),
    ).rejects.toMatchObject({ reason: "timeout" });
  });

  it("throws malformed-response on a body with no answers", async () => {
    await expect(
      askJev(
        { state: "s", questions: {} },
        {
          apiKey: "k",
          fetchImpl: (async () => jsonResponse({ model: "x" })) as unknown as typeof fetch,
        },
      ),
    ).rejects.toMatchObject({ reason: "malformed-response" });
  });

  it("throws malformed-response on an answer of unknown type", async () => {
    await expect(
      askJev(
        { state: "s", questions: {} },
        {
          apiKey: "k",
          fetchImpl: (async () =>
            jsonResponse({ answers: { a: { type: "rubric", value: 2 } } })) as unknown as typeof fetch,
        },
      ),
    ).rejects.toMatchObject({ reason: "malformed-response" });
  });

  it("throws network-error when fetch rejects for a non-abort reason", async () => {
    await expect(
      askJev(
        { state: "s", questions: {} },
        {
          apiKey: "k",
          fetchImpl: (async () => {
            throw new Error("ECONNREFUSED");
          }) as unknown as typeof fetch,
        },
      ),
    ).rejects.toMatchObject({ reason: "network-error" });
  });
});
