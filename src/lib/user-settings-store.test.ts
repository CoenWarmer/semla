/**
 * The system prompt and the chosen model decide how every session behaves, and
 * they lived only in Postgres — so with the database away a session silently
 * fell back to the default prompt with no model to run, which reads as Semla
 * being broken rather than the database being unavailable.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readUserSettings, writeUserSettings } from "./user-settings-store.ts";

const dir = () => mkdtempSync(join(tmpdir(), "semla-settings-"));
const USER = "9b00564c-0f56-498c-a5d0-d4ebcc0f8802";

describe("user settings on disk", () => {
  it("round-trips what was saved", () => {
    const d = dir();

    writeUserSettings(
      USER,
      { defaultModelId: "anthropic/claude-sonnet-5", defaultModelProvider: "openrouter" },
      d,
    );

    const settings = readUserSettings(USER, d)!;
    expect(settings.defaultModelId).toBe("anthropic/claude-sonnet-5");
    expect(settings.defaultModelProvider).toBe("openrouter");
    expect(settings.systemPrompt).toBeNull();
  });

  // The model and the prompt are saved from different screens; a whole-record
  // write would let one erase the other.
  it("merges, so saving a prompt does not clear the model", () => {
    const d = dir();
    writeUserSettings(USER, { defaultModelId: "m", defaultModelProvider: "p" }, d);

    writeUserSettings(USER, { systemPrompt: "be terse" }, d);

    const settings = readUserSettings(USER, d)!;
    expect(settings.defaultModelId).toBe("m");
    expect(settings.systemPrompt).toBe("be terse");
  });

  it("keeps an explicit null, which is how a prompt override is cleared", () => {
    const d = dir();
    writeUserSettings(USER, { systemPrompt: "be terse" }, d);

    writeUserSettings(USER, { systemPrompt: null }, d);

    expect(readUserSettings(USER, d)!.systemPrompt).toBeNull();
  });

  it("keeps users apart, so an exposed instance cannot leak a prompt", () => {
    const d = dir();
    writeUserSettings(USER, { systemPrompt: "mine" }, d);
    writeUserSettings("other-user", { systemPrompt: "theirs" }, d);

    expect(readUserSettings(USER, d)!.systemPrompt).toBe("mine");
    expect(readUserSettings("other-user", d)!.systemPrompt).toBe("theirs");
  });

  // Null means "nothing saved here yet", which is what sends the caller to
  // Postgres to seed from.
  it("has nothing for a user who has never saved", () => {
    expect(readUserSettings(USER, dir())).toBeNull();
  });

  it("survives a corrupt record rather than throwing", () => {
    const d = dir();
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, `user-settings.${USER}.json`), "{ truncated", "utf8");

    expect(readUserSettings(USER, d)).toBeNull();
  });
});
