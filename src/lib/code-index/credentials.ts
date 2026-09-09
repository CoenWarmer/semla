/**
 * Where the embedding credential comes from.
 *
 * Semla's agent directory, not the environment. `~/.semla/agent/auth.json` is
 * where every chat model in the harness already resolves its OpenRouter key
 * from, and it is isolated from the host's `~/.pi/agent` by `agent-dir.ts` so
 * that a change made with the `pi` CLI cannot alter Semla's behaviour. An index
 * that read `OPENROUTER_API_KEY` from the environment instead would be
 * configured somewhere else than the rest of the harness, and would keep
 * working after the operator revoked the key the agent uses.
 *
 * Absent credentials are not an error. The index is an optional capability:
 * with no key, `resolveEmbedder` returns null and `code_search` reports that it
 * is unconfigured, the way pi-llm-wiki's embeddings no-op without a provider.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PI_AGENT_DIR } from "@/lib/pi/agent-dir";

import {
  createOpenRouterEmbedder,
  DEFAULT_EMBEDDING_MODEL,
  type Embedder,
} from "./embed";

/**
 * Embedding models reachable through OpenRouter, with their native widths.
 *
 * Established by probing on 2026-09-09: they are absent from
 * `/api/v1/models`, which lists 430 chat models and no embedding models, so
 * there is nothing to discover them from at runtime. Pinned here so that a
 * model disappearing is a failing contract test rather than a run that indexes
 * a project against a model that no longer exists.
 */
export const EMBEDDING_MODELS: Readonly<Record<string, number>> = {
  "openai/text-embedding-3-small": 1536,
  "openai/text-embedding-3-large": 3072,
  "google/gemini-embedding-001": 3072,
  "qwen/qwen3-embedding-8b": 4096,
  "qwen/qwen3-embedding-4b": 2560,
  "baai/bge-m3": 1024,
};

/**
 * Widest vector pgvector will build an HNSW index over.
 *
 * Above this the Postgres backend needs `halfvec` or a truncated `dimensions`,
 * so a model over the ceiling is usable but not on its default width.
 */
export const PGVECTOR_HNSW_MAX_DIM = 2_000;

export interface EmbedderConfig {
  model?: string;
  /** Matryoshka truncation, for a model whose native width is inconvenient. */
  dimensions?: number;
  onUsage?: (usage: { tokens: number; cost?: number }) => void;
}

/** The OpenRouter key from Semla's agent directory, or null if unconfigured. */
export function readOpenRouterKey(agentDir: string = PI_AGENT_DIR): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf-8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const entry = (parsed as Record<string, unknown>).openrouter;
  if (typeof entry === "string") return entry.trim() || null;
  if (typeof entry === "object" && entry !== null) {
    // pi has written this both ways across versions; accept either shape rather
    // than silently reporting "no credentials" on a machine that has one.
    for (const field of ["apiKey", "api_key", "key"]) {
      const value = (entry as Record<string, unknown>)[field];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  return null;
}

/** An embedder, or null when no credential is configured. */
export function resolveEmbedder(config: EmbedderConfig = {}): Embedder | null {
  const apiKey = readOpenRouterKey();
  if (apiKey === null) return null;

  const model = config.model ?? DEFAULT_EMBEDDING_MODEL;
  const dim = EMBEDDING_MODELS[model];
  if (dim === undefined) {
    throw new Error(
      `code-index: unknown embedding model "${model}". Known models: ` +
        `${Object.keys(EMBEDDING_MODELS).join(", ")}.`,
    );
  }

  return createOpenRouterEmbedder({
    apiKey,
    model,
    dim,
    dimensions: config.dimensions,
    onUsage: config.onUsage,
  });
}
