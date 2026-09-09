/**
 * Credential resolution, and the model table.
 *
 * The table is pinned rather than discovered because OpenRouter's
 * `/api/v1/models` does not list embedding models at all — there is nothing to
 * read them from at runtime, so a model that disappears has to fail here.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_EMBEDDING_MODEL } from "./embed";
import {
  EMBEDDING_MODELS,
  PGVECTOR_HNSW_MAX_DIM,
  readOpenRouterKey,
} from "./credentials";

let agentDir: string;

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), "semla-agent-"));
});

afterEach(() => {
  rmSync(agentDir, { recursive: true, force: true });
});

function writeAuth(contents: unknown): void {
  writeFileSync(join(agentDir, "auth.json"), JSON.stringify(contents), "utf-8");
}

describe("readOpenRouterKey", () => {
  it("reads a bare string entry", () => {
    writeAuth({ openrouter: "sk-or-v1-abc" });
    expect(readOpenRouterKey(agentDir)).toBe("sk-or-v1-abc");
  });

  it("reads an object entry, in any of the shapes pi has written", () => {
    for (const field of ["apiKey", "api_key", "key"]) {
      writeAuth({ openrouter: { [field]: "sk-or-v1-abc" } });
      expect(readOpenRouterKey(agentDir)).toBe("sk-or-v1-abc");
    }
  });

  it("returns null rather than throwing when nothing is configured", () => {
    // An unconfigured index is a capability that is off, not a broken install.
    expect(readOpenRouterKey(agentDir)).toBeNull();

    writeAuth({ anthropic: "sk-ant-abc" });
    expect(readOpenRouterKey(agentDir)).toBeNull();
  });

  it("returns null for malformed or empty credentials", () => {
    writeFileSync(join(agentDir, "auth.json"), "not json", "utf-8");
    expect(readOpenRouterKey(agentDir)).toBeNull();

    writeAuth({ openrouter: "   " });
    expect(readOpenRouterKey(agentDir)).toBeNull();

    writeAuth({ openrouter: { unrelated: "x" } });
    expect(readOpenRouterKey(agentDir)).toBeNull();
  });
});

describe("EMBEDDING_MODELS", () => {
  it("holds the models verified against the live endpoint", () => {
    expect(EMBEDDING_MODELS).toEqual({
      "openai/text-embedding-3-small": 1536,
      "openai/text-embedding-3-large": 3072,
      "google/gemini-embedding-001": 3072,
      "qwen/qwen3-embedding-8b": 4096,
      "qwen/qwen3-embedding-4b": 2560,
      "baai/bge-m3": 1024,
    });
  });

  it("defaults to a model that fits pgvector's HNSW ceiling untruncated", () => {
    // The reason 3-small is the default rather than a stronger, wider model:
    // everything above the ceiling needs halfvec or truncation to be indexable.
    expect(EMBEDDING_MODELS[DEFAULT_EMBEDDING_MODEL]).toBeLessThanOrEqual(
      PGVECTOR_HNSW_MAX_DIM,
    );
  });

  it("records which models need truncation for the Postgres backend", () => {
    const overCeiling = Object.entries(EMBEDDING_MODELS)
      .filter(([, dim]) => dim > PGVECTOR_HNSW_MAX_DIM)
      .map(([model]) => model);

    expect(overCeiling).toEqual([
      "openai/text-embedding-3-large",
      "google/gemini-embedding-001",
      "qwen/qwen3-embedding-8b",
      "qwen/qwen3-embedding-4b",
    ]);
  });
});
