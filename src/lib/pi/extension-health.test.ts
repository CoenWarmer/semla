import { afterEach, describe, expect, it } from "vitest";

import {
  clearSlot,
  CONTRACT_SLOT_KEYS,
  EXTENSION_CONTRACT_VERSION,
} from "./extension-contract.ts";
import { getExtensionHealth, recordExtensionLoad } from "./extension-health.ts";
import {
  buildExtensionLoadReport,
  EXTENSION_MANIFEST,
  extensionEntryId,
} from "./extension-manifest.ts";

afterEach(() => {
  for (const key of CONTRACT_SLOT_KEYS) clearSlot(key);
});

describe("extension health", () => {
  it("reports the manifest in load order with the entry files installed", async () => {
    const health = await getExtensionHealth();

    expect(health.contractVersion).toBe(EXTENSION_CONTRACT_VERSION);
    expect(health.manifest).toHaveLength(EXTENSION_MANIFEST.length);
    expect(health.installation.ok).toBe(true);
    expect(health.installation.problems).toEqual([]);

    const ids = health.manifest.map((e) => e.id);
    expect(ids.indexOf("wiki-ingest-bridge")).toBeGreaterThan(
      ids.indexOf("workflow"),
    );
  });

  it("is ok before any session has run, and says so", async () => {
    const health = await getExtensionHealth();
    expect(health.lastLoad).toBeNull();
    expect(health.ok).toBe(true);
  });

  it("surfaces a failed load from the last session", async () => {
    // No slots are armed here, so the workflow extension counts as loaded but
    // silent — the shape of a real degradation.
    recordExtensionLoad(
      buildExtensionLoadReport({
        loadedPaths: EXTENSION_MANIFEST.map(extensionEntryId),
        loadErrors: [],
        registeredTools: [],
      }),
    );

    const health = await getExtensionHealth();

    expect(health.ok).toBe(false);
    expect(health.lastLoad?.ok).toBe(false);
    expect(health.lastLoad?.observedAt).toBeTruthy();
    expect(health.lastLoad?.problems.join("\n")).toMatch(
      /did not register workflow/,
    );
  });

  it("reports a healthy load", async () => {
    const tools = EXTENSION_MANIFEST.flatMap((s) => [...s.providesTools]);
    for (const spec of EXTENSION_MANIFEST) {
      for (const slot of spec.providesSlots) {
        (globalThis as Record<symbol, unknown>)[slot] = () => true;
      }
    }

    recordExtensionLoad(
      buildExtensionLoadReport({
        loadedPaths: EXTENSION_MANIFEST.map(extensionEntryId),
        loadErrors: [],
        registeredTools: tools,
      }),
    );

    const health = await getExtensionHealth();
    expect(health.ok).toBe(true);
    expect(health.lastLoad?.problems).toEqual([]);
  });

  it("reports the mcp config summary when the mcp extension is in the manifest", async () => {
    const health = await getExtensionHealth();

    const hasMcp = EXTENSION_MANIFEST.some((spec) => spec.id === "mcp");
    expect(hasMcp).toBe(true);
    expect(health.mcp).not.toBeNull();
    expect(Array.isArray(health.mcp?.servers)).toBe(true);
  });
});
