/**
 * The settings file is machine-local and untracked, so these tests are the only
 * place the asserted values are checked against anything. The shape matters as
 * much as the values: `loadTaskConfig` merges whole sections, and pi keeps the
 * model picker's defaults and its package list in the same file, so a write
 * that replaced the document rather than one key of it would take those out.
 */

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  configureWikiEmbeddings,
  describeWikiEmbeddings,
  WIKI_EMBEDDING_KEY_ENV,
  WIKI_EMBEDDING_SETTINGS,
  WIKI_SETTINGS_SECTION,
} from "./wiki-embedding-config.ts";

const originalKey = process.env[WIKI_EMBEDDING_KEY_ENV];

function agentDirWithKey(key: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), "semla-wiki-embed-"));
  if (key !== null) {
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ openrouter: { apiKey: key } }));
  }
  return dir;
}

function readSettings(dir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, "settings.json"), "utf-8")) as Record<string, unknown>;
}

beforeEach(() => {
  delete process.env[WIKI_EMBEDDING_KEY_ENV];
});

afterEach(() => {
  if (originalKey === undefined) delete process.env[WIKI_EMBEDDING_KEY_ENV];
  else process.env[WIKI_EMBEDDING_KEY_ENV] = originalKey;
});

describe("configureWikiEmbeddings", () => {
  it("writes the embedding section and publishes the key", () => {
    const dir = agentDirWithKey("sk-or-test-key");

    const setup = configureWikiEmbeddings({ agentDir: dir });

    expect(setup.configured).toBe(true);
    expect(setup.written).toBe(true);
    expect(process.env[WIKI_EMBEDDING_KEY_ENV]).toBe("sk-or-test-key");
    expect(readSettings(dir)[WIKI_SETTINGS_SECTION]).toEqual(WIKI_EMBEDDING_SETTINGS);
  });

  it("names an env var for the key rather than writing the secret to the file", () => {
    const dir = agentDirWithKey("sk-or-secret");

    configureWikiEmbeddings({ agentDir: dir });

    expect(readFileSync(join(dir, "settings.json"), "utf-8")).not.toContain("sk-or-secret");
    expect(WIKI_EMBEDDING_SETTINGS.embeddingApiKeyEnv).toBe(WIKI_EMBEDDING_KEY_ENV);
  });

  it("points at an OpenAI-compatible provider, which is what resolveEmbedder accepts", () => {
    // resolveEmbedder returns undefined for any other provider string, which
    // would leave recall lexical with a fully populated settings file.
    expect(["openai", "openai-compatible"]).toContain(WIKI_EMBEDDING_SETTINGS.embeddingProvider);
  });

  it("keeps unrelated settings, including pi's own", () => {
    const dir = agentDirWithKey("sk-or-test-key");
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({ defaultModel: "sonnet", packages: ["a"] }),
    );

    configureWikiEmbeddings({ agentDir: dir });

    const settings = readSettings(dir);
    expect(settings.defaultModel).toBe("sonnet");
    expect(settings.packages).toEqual(["a"]);
    expect(settings[WIKI_SETTINGS_SECTION]).toEqual(WIKI_EMBEDDING_SETTINGS);
  });

  it("keeps unrelated keys already inside the llm-wiki section", () => {
    const dir = agentDirWithKey("sk-or-test-key");
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({ [WIKI_SETTINGS_SECTION]: { taskModel: "haiku" } }),
    );

    configureWikiEmbeddings({ agentDir: dir });

    expect(readSettings(dir)[WIKI_SETTINGS_SECTION]).toMatchObject({
      taskModel: "haiku",
      ...WIKI_EMBEDDING_SETTINGS,
    });
  });

  it("does not rewrite a file that already agrees", () => {
    const dir = agentDirWithKey("sk-or-test-key");
    configureWikiEmbeddings({ agentDir: dir });

    const second = configureWikiEmbeddings({ agentDir: dir });

    expect(second.configured).toBe(true);
    expect(second.written).toBe(false);
  });

  it("stays off, and writes nothing, with no credential", () => {
    const dir = agentDirWithKey(null);

    const setup = configureWikiEmbeddings({ agentDir: dir });

    expect(setup.configured).toBe(false);
    expect(setup.written).toBe(false);
    expect(setup.reason).toContain("auth.json");
    expect(process.env[WIKI_EMBEDDING_KEY_ENV]).toBeUndefined();
    expect(() => readSettings(dir)).toThrow();
  });

  it("says which ranking is in use either way", () => {
    const configured = configureWikiEmbeddings({ agentDir: agentDirWithKey("sk-or-test-key") });
    const absent = configureWikiEmbeddings({ agentDir: agentDirWithKey(null) });

    expect(describeWikiEmbeddings(configured)).toContain(WIKI_EMBEDDING_SETTINGS.embeddingModel);
    expect(describeWikiEmbeddings(absent)).toContain("lexical");
  });
});
