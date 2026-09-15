/**
 * The catalog is only fresh if the network flag is set — refreshOnCreate alone
 * rebuilds from disk — and a boot must survive that fetch failing, because the
 * seeded snapshot is still a working catalog.
 */
import { describe, expect, it, vi } from "vitest";

import { refreshModelCatalog } from "./model-catalog.ts";

const fakeRuntime = (models: number) =>
  ({
    getAvailable: async () => Array.from({ length: models }, (_, i) => ({ id: `m${i}` })),
  }) as never;

describe("refreshModelCatalog", () => {
  it("asks for a network refresh, not just a rebuild from disk", async () => {
    const create = vi.fn().mockResolvedValue(fakeRuntime(3));

    await refreshModelCatalog({ create, timeoutMs: 1_000 });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        refreshOnCreate: true,
        // Without this the runtime never touches the network, so the catalog
        // would stay exactly as seeded.
        allowModelNetwork: true,
        modelRefreshTimeoutMs: 1_000,
      }),
    );
  });

  it("reports how many models it ended up with", async () => {
    const create = vi.fn().mockResolvedValue(fakeRuntime(346));

    expect(await refreshModelCatalog({ create })).toEqual({
      refreshed: true,
      models: 346,
    });
  });

  it("survives a failed fetch rather than taking the boot down", async () => {
    const create = vi.fn().mockRejectedValue(new Error("ENOTFOUND models.dev"));

    const result = await refreshModelCatalog({ create });

    expect(result.refreshed).toBe(false);
    expect(result.error).toContain("ENOTFOUND");
  });

  it("bounds the fetch so a hanging network cannot stall a restart", async () => {
    const create = vi.fn().mockResolvedValue(fakeRuntime(1));

    await refreshModelCatalog({ create });

    const passed = create.mock.calls[0]![0] as { modelRefreshTimeoutMs: number };
    expect(passed.modelRefreshTimeoutMs).toBeGreaterThan(0);
  });
});
