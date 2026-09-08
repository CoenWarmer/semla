/**
 * Model tier configuration API route tests.
 *
 * Verifies that:
 * - GET returns the repo-local config when it exists, or an explicit "absent" signal
 * - PUT rejects unknown tier names (only small/medium/big are meaningful)
 * - PUT removes cleared tiers from the map rather than storing them as ""
 * - PUT writes to the PROJECT path (cwd/.pi/workflows/model-tiers.json), not the home file
 * - An all-cleared PUT is rejected with a clear message rather than writing a degenerate map
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

import { GET, PUT } from "./route";

// Mock requireUser to avoid Next.js request context dependency in unit tests.
vi.mock("@/lib/api-helpers", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/api-helpers")>();
  return {
    ...original,
    requireUser: vi.fn().mockResolvedValue({
      supabase: {},
      user: { id: "test-user" },
    }),
  };
});

let tempDir: string;
let originalCwd: string;

beforeEach(() => {
  originalCwd = process.cwd();
  tempDir = mkdtempSync(join(tmpdir(), "semla-tiers-api-"));
  process.chdir(tempDir);
});

afterEach(() => {
  process.chdir(originalCwd);
  if (existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

function writeConfig(tiers: Record<string, string>) {
  const dir = join(tempDir, ".pi", "workflows");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "model-tiers.json"), JSON.stringify({ tiers }), "utf-8");
}

describe("GET /api/model-tiers", () => {
  it("returns exists=false when no config exists", async () => {
    const response = await GET();
    const data = await response.json();

    expect(data).toEqual({ exists: false, tiers: null });
  });

  /**
   * The endpoint must read the repository file only, never ~/.pi/workflows.
   *
   * loadModelTierConfig({ cwd }) deliberately falls back to the home file, and
   * that is correct when *resolving* a subagent's model. It is wrong here: this
   * route backs an editor labelled as the committed repo config, so a fallback
   * shows another project's tiers as this repository's, and the next save
   * copies them in.
   *
   * It also made the suite non-hermetic. With a real home config present, four
   * tests failed; they had only ever passed because an earlier run of these
   * tests deleted the developer's file.
   */
  it("does not fall back to the user-level config", async () => {
    const home = join(homedir(), ".pi", "workflows", "model-tiers.json");
    const existing = existsSync(home) ? readFileSync(home, "utf-8") : null;
    mkdirSync(dirname(home), { recursive: true });
    writeFileSync(
      home,
      JSON.stringify({ tiers: { small: "home/should-not-appear" } }),
      "utf-8",
    );

    try {
      // cwd is the temp dir, which has no project config.
      const data = (await (await GET()).json()) as {
        exists: boolean;
        tiers: Record<string, string> | null;
      };
      expect(data).toEqual({ exists: false, tiers: null });
    } finally {
      if (existing === null) rmSync(home, { force: true });
      else writeFileSync(home, existing, "utf-8");
    }
  });

  it("returns the current tiers when config exists", async () => {
    writeConfig({ small: "openrouter/cheap", big: "openrouter/dear" });

    const response = await GET();
    const data = await response.json();

    expect(data).toEqual({
      exists: true,
      tiers: { small: "openrouter/cheap", big: "openrouter/dear" },
    });
  });

  it("ignores a corrupt config file", async () => {
    const dir = join(tempDir, ".pi", "workflows");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "model-tiers.json"), "{ not json", "utf-8");

    const response = await GET();
    const data = await response.json();

    expect(data).toEqual({ exists: false, tiers: null });
  });

  it("ignores a degenerate config (empty map)", async () => {
    writeConfig({});

    const response = await GET();
    const data = await response.json();

    expect(data).toEqual({ exists: false, tiers: null });
  });

  it("ignores a degenerate config (tier mapped to empty string)", async () => {
    writeConfig({ small: "" });

    const response = await GET();
    const data = await response.json();

    expect(data).toEqual({ exists: false, tiers: null });
  });
});

describe("PUT /api/model-tiers", () => {
  it("writes to the PROJECT path, not the home path", async () => {
    const request = new Request("http://localhost/api/model-tiers", {
      method: "PUT",
      body: JSON.stringify({ tiers: { small: "openrouter/test" } }),
    });

    await PUT(request);

    const projectPath = join(tempDir, ".pi", "workflows", "model-tiers.json");
    expect(existsSync(projectPath)).toBe(true);

    const written = JSON.parse(readFileSync(projectPath, "utf-8"));
    expect(written.tiers.small).toBe("openrouter/test");
  });

  it("round-trips a valid tier config", async () => {
    const request = new Request("http://localhost/api/model-tiers", {
      method: "PUT",
      body: JSON.stringify({
        tiers: {
          small: "openrouter/anthropic/claude-haiku-4.5",
          medium: "openrouter/anthropic/claude-sonnet-4.5",
          big: "openrouter/anthropic/claude-opus-4.5",
        },
      }),
    });

    const putResponse = await PUT(request);
    expect(putResponse.status).toBe(200);

    const getResponse = await GET();
    const data = await getResponse.json();

    expect(data.tiers).toEqual({
      small: "openrouter/anthropic/claude-haiku-4.5",
      medium: "openrouter/anthropic/claude-sonnet-4.5",
      big: "openrouter/anthropic/claude-opus-4.5",
    });
  });

  it("removes cleared tiers from the map rather than storing them as empty string", async () => {
    // Start with all three tiers.
    writeConfig({
      small: "openrouter/cheap",
      medium: "openrouter/mid",
      big: "openrouter/dear",
    });

    // Clear the "medium" tier.
    const request = new Request("http://localhost/api/model-tiers", {
      method: "PUT",
      body: JSON.stringify({
        tiers: {
          small: "openrouter/cheap",
          medium: "",
          big: "openrouter/dear",
        },
      }),
    });

    await PUT(request);

    const projectPath = join(tempDir, ".pi", "workflows", "model-tiers.json");
    const written = JSON.parse(readFileSync(projectPath, "utf-8"));

    // "medium" should be absent, not stored as "".
    expect(Object.keys(written.tiers)).toEqual(["small", "big"]);
    expect(written.tiers.medium).toBeUndefined();
  });

  it("rejects unknown tier names", async () => {
    const request = new Request("http://localhost/api/model-tiers", {
      method: "PUT",
      body: JSON.stringify({
        tiers: {
          small: "openrouter/cheap",
          unknown: "openrouter/something",
        },
      }),
    });

    const response = await PUT(request);
    expect(response.status).toBe(400);

    const data = await response.json();
    expect(data.error).toContain("Unknown tier names");
    expect(data.error).toContain("unknown");
  });

  it("rejects an all-cleared tier map with a clear message", async () => {
    writeConfig({ small: "openrouter/a", medium: "openrouter/b", big: "openrouter/c" });

    const request = new Request("http://localhost/api/model-tiers", {
      method: "PUT",
      body: JSON.stringify({
        tiers: { small: "", medium: "  ", big: "" },
      }),
    });

    const response = await PUT(request);
    expect(response.status).toBe(400);

    const data = await response.json();
    expect(data.error).toContain("All tiers are cleared");
    expect(data.error).toContain("empty tier map");
  });

  it("accepts a spec with a thinking level suffix", async () => {
    const request = new Request("http://localhost/api/model-tiers", {
      method: "PUT",
      body: JSON.stringify({
        tiers: { small: "openrouter/anthropic/claude-haiku-4.5:low" },
      }),
    });

    const response = await PUT(request);
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.tiers.small).toBe("openrouter/anthropic/claude-haiku-4.5:low");
  });

  it("rejects a request with no tiers field", async () => {
    const request = new Request("http://localhost/api/model-tiers", {
      method: "PUT",
      body: JSON.stringify({}),
    });

    const response = await PUT(request);
    expect(response.status).toBe(400);

    const data = await response.json();
    expect(data.error).toContain("tiers object");
  });

  it("rejects malformed JSON", async () => {
    const request = new Request("http://localhost/api/model-tiers", {
      method: "PUT",
      body: "{ not json",
    });

    const response = await PUT(request);
    expect(response.status).toBe(400);
  });
});
