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

/**
 * Minimal Supabase stub: one row per table, or null.
 *
 * `eq()` answers both shapes the code uses — awaited directly for a list, and
 * `.maybeSingle()` for a single row — because a stub that only knew the second
 * silently returned nothing for the first.
 */
const supabaseWith = (rows: Record<string, unknown>) =>
  ({
    from: (table: string) => ({
      select: () => {
        const data = rows[table] ?? null;
        const answer = {
          maybeSingle: async () => ({ data }),
          // oxlint-disable-next-line no-thenable -- the point of this stub is
          // to be a thenable, like the Supabase query builder it stands in for.
          then: (resolve: (value: { data: unknown }) => void) =>
            resolve({ data: Array.isArray(data) ? data : [] }),
        };
        return { eq: () => answer };
      },
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
        session_projects: [
          {
            project_path: "one",
            origin: "explicit",
            is_primary: true,
            first_attached_at: "2026-09-01T10:00:00.000Z",
            last_touched_at: "2026-09-01T10:00:00.000Z",
          },
        ],
      }),
      "session-1",
      "user-1",
    );

    expect(result.systemPrompt).toContain("DB_PROMPT");
    // The mirror is the fallback now that project_path is gone.
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
