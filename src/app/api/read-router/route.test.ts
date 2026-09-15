/**
 * The prompt editor's read-router toggle controls the same workflow setting
 * the extension reads before every tool result.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getWorkflowSettingsPath } from "@/lib/pi/extensions/dynamic-workflows/src/workflow-settings";
import { GET, PUT } from "./route";

vi.mock("@/lib/api/api-helpers", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/api/api-helpers")>();
  return {
    ...original,
    requireUser: vi.fn().mockResolvedValue({
      supabase: {},
      user: { id: "test-user" },
    }),
  };
});

const settingsPath = getWorkflowSettingsPath();

beforeEach(() => {
  rmSync(settingsPath, { force: true });
});

afterEach(() => {
  rmSync(settingsPath, { force: true });
});

describe("GET /api/read-router", () => {
  it("defaults to enabled when the setting is absent", async () => {
    expect(await (await GET()).json()).toEqual({ enabled: true });
  });

  it("returns the stored setting", async () => {
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(
      settingsPath,
      JSON.stringify({ readRouterEnabled: false }),
      "utf8",
    );

    expect(await (await GET()).json()).toEqual({ enabled: false });
  });
});

describe("PUT /api/read-router", () => {
  it("persists the toggle", async () => {
    const response = await PUT(
      new Request("http://localhost/api/read-router", {
        body: JSON.stringify({ enabled: false }),
        method: "PUT",
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ enabled: false });
    expect(existsSync(settingsPath)).toBe(true);
    expect(await (await GET()).json()).toEqual({ enabled: false });
  });

  it("rejects a non-boolean value", async () => {
    const response = await PUT(
      new Request("http://localhost/api/read-router", {
        body: JSON.stringify({ enabled: "false" }),
        method: "PUT",
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Request body must contain a boolean enabled value.",
    });
  });
});
