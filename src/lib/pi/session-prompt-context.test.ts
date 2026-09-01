import { beforeEach, describe, expect, it, vi } from "vitest";

const readUserSettingsMock = vi.hoisted(() => vi.fn());
const readSessionMetaMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/user-settings-store", () => ({
  readUserSettings: readUserSettingsMock,
}));
vi.mock("@/lib/pi/session-meta", () => ({
  readSessionMeta: readSessionMetaMock,
}));
vi.mock("@/lib/pi/prompts", () => ({
  buildMemoryContextBlock: () => "MEMORY_BLOCK",
}));
vi.mock("@/lib/pi/system-prompt", () => ({
  DEFAULT_SYSTEM_PROMPT: "DEFAULT_PROMPT",
}));

const { resolveSessionPromptContext } = await import("./session-prompt-context");

/** Minimal Supabase stub: one row per table, or null. */
const supabaseWith = (rows: Record<string, unknown>) =>
  ({
    from: (table: string) => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: rows[table] ?? null }) }),
      }),
    }),
  }) as never;

describe("resolveSessionPromptContext", () => {
  beforeEach(() => {
    readUserSettingsMock.mockReset();
    readSessionMetaMock.mockReset();
    readUserSettingsMock.mockReturnValue(null);
    readSessionMetaMock.mockReturnValue(null);
  });

  it("prefers settings on disk over the database", async () => {
    // Settings live on disk in local mode; reading only the database reported
    // no default model at all, which left the context bar with no window size.
    readUserSettingsMock.mockReturnValue({
      defaultModelId: "anthropic/claude-sonnet-5",
      defaultModelProvider: "openrouter",
      systemPrompt: "DISK_PROMPT",
    });

    const result = await resolveSessionPromptContext(
      supabaseWith({
        user_settings: {
          system_prompt: "DB_PROMPT",
          default_model_id: "db-model",
          default_model_provider: "db-provider",
        },
      }),
      "session-1",
      "user-1",
    );

    expect(result.systemPrompt).toContain("DISK_PROMPT");
    expect(result.defaultModel).toEqual({
      provider: "openrouter",
      modelId: "anthropic/claude-sonnet-5",
    });
  });

  it("falls back to the database when nothing is on disk", async () => {
    const result = await resolveSessionPromptContext(
      supabaseWith({
        user_settings: {
          system_prompt: "DB_PROMPT",
          default_model_id: "db-model",
          default_model_provider: "db-provider",
        },
        sessions: { project_path: "/workspace/one" },
      }),
      "session-1",
      "user-1",
    );

    expect(result.systemPrompt).toContain("DB_PROMPT");
    // The row is the last fallback, and it arrives as a link now.
    expect(result.projects).toEqual(["one"]);
    expect(result.defaultModel).toEqual({
      provider: "db-provider",
      modelId: "db-model",
    });
  });

  it("uses the built-in prompt when neither source has one", async () => {
    const result = await resolveSessionPromptContext(
      supabaseWith({}),
      "session-1",
      "user-1",
    );
    expect(result.systemPrompt).toContain("DEFAULT_PROMPT");
    expect(result.defaultModel).toBeNull();
  });

  it("always appends the memory block, so the measured prompt is the real one", () => {
    return expect(
      resolveSessionPromptContext(supabaseWith({}), "s", "u"),
    ).resolves.toMatchObject({
      systemPrompt: expect.stringContaining("MEMORY_BLOCK") as unknown as string,
    });
  });

  it("reports no default model when only half of one is set", async () => {
    readUserSettingsMock.mockReturnValue({
      defaultModelId: null,
      defaultModelProvider: "openrouter",
      systemPrompt: null,
    });
    const result = await resolveSessionPromptContext(
      supabaseWith({}),
      "s",
      "u",
    );
    expect(result.defaultModel).toBeNull();
  });
});
