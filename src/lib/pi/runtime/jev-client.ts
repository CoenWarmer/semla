/**
 * A client for OpenRouter's alpha Decisions API, and nothing else.
 *
 * `~typesafe/jev-latest` is not a chat model. It answers narrow typed
 * questions with calibrated probabilities and generates no text, so it is not
 * reachable through `ModelRegistry.complete()`, which is shaped for chat
 * completions — hence a direct `fetch`, following `code-index/embed.ts` rather
 * than `cheap-model.ts`. Conceptually it is a sibling of `cheap-model.ts`
 * ("which inexpensive model answers a narrow typed question"); mechanically it
 * shares nothing with it.
 *
 * **This module makes no availability decision.** It throws on a non-2xx, a
 * timeout, or a malformed body, and the caller chooses fail-open or
 * fail-closed. `jev-gate.ts` fails closed; `read-router.ts` fails open for its
 * own, different reason. Putting that choice here would take it away from both.
 *
 * ## What was established by probing, not by documentation
 *
 * The response shape below was recorded from a live call on 2026-09-19 via
 * `scripts/probe-jev.mjs`, the same discipline `code-index/credentials.ts`
 * uses for the embedding models that are absent from `/api/v1/models`. Three
 * findings are load-bearing and are not on the model's page:
 *
 *  1. **A `noul` question's `criteria` must be keyed `"true"`/`"false"`.**
 *     Keys `"yes"`/`"no"` are rejected with a 400 and a zod `invalid_union`
 *     error at `questions.<key>.criteria.yes`. {@link noulQuestion} exists so
 *     no caller has to remember this.
 *  2. **`choice.probabilities` is a normalised distribution summing to 1** — a
 *     single-pick ranking, not independent per-option relevance. It therefore
 *     cannot express multi-select, which is what a relevance filter needs:
 *     adding candidates mechanically depresses every score, and in one probe
 *     it gave a skill 0.96 for an unrelated turn purely because the only other
 *     option was less related still. `docs/plans/jev-agent-gating.md` §4
 *     proposed thresholding this; that design does not work, and
 *     `jev-gate.ts` asks one independent `noul` per candidate instead.
 *  3. **`choice` and `score` answers carry a `confidence` field**, and `score`
 *     carries a `legend` mapping rubric positions to their labels. Both are
 *     absent from the plan and are preserved here.
 */

import { readOpenRouterKey } from "@/lib/code-index/credentials";

export const JEV_MODEL = "~typesafe/jev-latest";
export const JEV_DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";

/** Default deadline for one decisions call. Live calls measured 335–465 ms. */
export const JEV_DEFAULT_TIMEOUT_MS = 2000;

export type JevQuestionType = "noul" | "choice" | "score";

export interface JevQuestion {
  type: JevQuestionType;
  instructions: string;
  /**
   * A record of option key to its description, or an ordered array of rubric
   * labels for a `score`. For `noul` the keys must be `"true"` and `"false"`.
   */
  criteria: Record<string, string> | string[];
}

export interface JevDecisionRequest {
  state: string | object | unknown[];
  questions: Record<string, JevQuestion>;
}

export interface JevNoulAnswer {
  type: "noul";
  /** Calibrated probability in [0, 1] that the `true` criterion holds. */
  noul: number;
}

export interface JevChoiceAnswer {
  type: "choice";
  choice: string;
  /** Normalised over the options — see finding (2) in the module docblock. */
  probabilities: Record<string, number>;
  confidence?: number;
}

export interface JevScoreAnswer {
  type: "score";
  score: number;
  legend?: Record<string, string>;
  probabilities?: Record<string, number>;
  confidence?: number;
}

export type JevAnswer = JevNoulAnswer | JevChoiceAnswer | JevScoreAnswer;

export interface JevUsage {
  inputTokens: number;
  outputTokens: number;
  /** USD. Absent on upstreams that do not report it. */
  cost?: number;
}

export interface JevDecisionResult {
  answers: Record<string, JevAnswer>;
  /** The concrete version the `~latest` alias resolved to, e.g. `typesafe/jev-1.13-20260917`. */
  model?: string;
  usage?: JevUsage;
  /** OpenRouter generation id, for correlating a decision with its bill. */
  id?: string;
  /** Wall-clock duration of the HTTP call, for the latency budget. */
  elapsedMs: number;
}

/** Why a decision could not be obtained. Distinguished so spans can say which. */
export type JevErrorReason =
  | "no-credentials"
  | "timeout"
  | "http-error"
  | "malformed-response"
  | "network-error";

export class JevError extends Error {
  readonly reason: JevErrorReason;
  readonly status?: number;

  constructor(reason: JevErrorReason, message: string, status?: number) {
    super(message);
    this.name = "JevError";
    this.reason = reason;
    this.status = status;
  }
}

/**
 * A yes/no question, with its criteria keyed the way the API demands.
 *
 * Every `noul` question in Semla goes through this rather than building the
 * record inline, because `yes`/`no` is the natural spelling, is what the first
 * probe used, and is a 400.
 */
export function noulQuestion(
  instructions: string,
  whenTrue: string,
  whenFalse: string,
): JevQuestion {
  return {
    type: "noul",
    instructions,
    criteria: { true: whenTrue, false: whenFalse },
  };
}

function parseAnswer(key: string, raw: unknown): JevAnswer {
  if (typeof raw !== "object" || raw === null) {
    throw new JevError("malformed-response", `answer "${key}" is not an object`);
  }
  const value = raw as Record<string, unknown>;

  switch (value.type) {
    case "noul": {
      if (typeof value.noul !== "number") {
        throw new JevError("malformed-response", `answer "${key}" has no numeric noul`);
      }
      return { type: "noul", noul: value.noul };
    }
    case "choice": {
      if (typeof value.choice !== "string") {
        throw new JevError("malformed-response", `answer "${key}" has no choice`);
      }
      const probabilities =
        typeof value.probabilities === "object" && value.probabilities !== null
          ? (value.probabilities as Record<string, number>)
          : {};
      return {
        type: "choice",
        choice: value.choice,
        probabilities,
        ...(typeof value.confidence === "number" ? { confidence: value.confidence } : {}),
      };
    }
    case "score": {
      if (typeof value.score !== "number") {
        throw new JevError("malformed-response", `answer "${key}" has no numeric score`);
      }
      return {
        type: "score",
        score: value.score,
        ...(typeof value.legend === "object" && value.legend !== null
          ? { legend: value.legend as Record<string, string> }
          : {}),
        ...(typeof value.probabilities === "object" && value.probabilities !== null
          ? { probabilities: value.probabilities as Record<string, number> }
          : {}),
        ...(typeof value.confidence === "number" ? { confidence: value.confidence } : {}),
      };
    }
    default:
      throw new JevError(
        "malformed-response",
        `answer "${key}" has unknown type ${JSON.stringify(value.type)}`,
      );
  }
}

export interface AskJevOptions {
  /** Overrides the key from Semla's agent directory. */
  apiKey?: string;
  timeoutMs?: number;
  /** Injected for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Caller's cancellation, composed with the timeout. */
  signal?: AbortSignal;
}

/**
 * Ask Jev one batch of questions. One HTTP round trip, whatever the count.
 *
 * No retries: a decision is only useful before the agent acts, so a second
 * attempt would spend the caller's latency budget rather than the caller's
 * choice. A caller that wants one can call again.
 */
export async function askJev(
  request: JevDecisionRequest,
  options: AskJevOptions = {},
): Promise<JevDecisionResult> {
  const apiKey = options.apiKey ?? readOpenRouterKey();
  if (!apiKey) {
    throw new JevError("no-credentials", "no OpenRouter key in Semla's agent directory");
  }

  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? JEV_DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onCallerAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onCallerAbort);

  const started = Date.now();
  try {
    let response: Response;
    try {
      response = await doFetch(JEV_DECISIONS_URL, {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: JEV_MODEL,
          state: request.state,
          questions: request.questions,
        }),
        signal: controller.signal,
      });
    } catch (error) {
      // An abort here is the timeout firing far more often than it is the
      // caller's signal, and the two are worth telling apart in a span.
      if (controller.signal.aborted) {
        throw new JevError("timeout", `no decision within ${timeoutMs}ms`);
      }
      throw new JevError(
        "network-error",
        error instanceof Error ? error.message : String(error),
      );
    }

    const elapsedMs = Date.now() - started;
    const text = await response.text();

    if (!response.ok) {
      // The body carries the zod validation detail that says which question
      // was malformed; a bare status would leave the caller guessing.
      throw new JevError(
        "http-error",
        `HTTP ${response.status}: ${text.slice(0, 600)}`,
        response.status,
      );
    }

    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new JevError("malformed-response", "response body is not JSON");
    }
    if (typeof body !== "object" || body === null) {
      throw new JevError("malformed-response", "response body is not an object");
    }

    const envelope = body as Record<string, unknown>;
    const rawAnswers = envelope.answers;
    if (typeof rawAnswers !== "object" || rawAnswers === null) {
      throw new JevError("malformed-response", "response has no answers object");
    }

    const answers: Record<string, JevAnswer> = {};
    for (const [key, raw] of Object.entries(rawAnswers as Record<string, unknown>)) {
      answers[key] = parseAnswer(key, raw);
    }

    const rawUsage = envelope.usage;
    const usage =
      typeof rawUsage === "object" && rawUsage !== null
        ? (() => {
            const u = rawUsage as Record<string, unknown>;
            return {
              inputTokens: typeof u.input_tokens === "number" ? u.input_tokens : 0,
              outputTokens: typeof u.output_tokens === "number" ? u.output_tokens : 0,
              ...(typeof u.cost === "number" ? { cost: u.cost } : {}),
            };
          })()
        : undefined;

    return {
      answers,
      elapsedMs,
      ...(typeof envelope.model === "string" ? { model: envelope.model } : {}),
      ...(typeof envelope.id === "string" ? { id: envelope.id } : {}),
      ...(usage ? { usage } : {}),
    };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onCallerAbort);
  }
}
