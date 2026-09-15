/**
 * What a context inspection reports: dimension scores, overall quality, and
 * suggested interventions.
 *
 * Deliberately free of node imports. Client components and hooks read every
 * one of these, while the inspector route and LLM pass that produce them live
 * under src/lib/context-check/ and src/app/api/. See client-boundary.test.ts
 * for why that separation is load-bearing: a type-only import from a route
 * module still couples the client graph to server-only transitive deps once
 * someone adds a value import.
 *
 * The same split as src/lib/review-types.ts, for the same reason.
 */

export type DimensionLevel = "good" | "warning" | "degraded";

export type DimensionScore = {
  level: DimensionLevel;
  summary: string;
};

export type CompositionBreakdown = {
  assistantFraction: number;
  /** Fraction of the model's context window currently in use. Null if unknown. */
  contextWindowFraction: number | null;
  summary: string;
  systemPromptFraction: number;
  toolResultFraction: number;
  userFraction: number;
};

export type ContextCheckResult = {
  checkedAt: string;
  dimensions: {
    composition: CompositionBreakdown;
    correctionRate: DimensionScore & {
      correctionCount: number;
      rate: number;
      userTurns: number;
    };
    goalDrift: DimensionScore;
    staleness: DimensionScore;
    supersessionDepth: DimensionScore;
  };
  interventions: Array<{ action: "restart" | "restate-goal" | "summarize"; label: string }>;
  quality: DimensionLevel;
  summary: string;
  turnCount: number;
};

export type StoredInspection = { createdAt: string; id: string; result: ContextCheckResult };
