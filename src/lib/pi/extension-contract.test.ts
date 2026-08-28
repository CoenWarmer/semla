/**
 * The contract's string keys are a wire format, not an implementation detail:
 * @zosmaai/pi-llm-wiki reads two of them by literal, and any extension loaded
 * into a separate module scope can only find a slot by spelling it identically.
 * These tests freeze the strings and cover the typed accessors.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  ACTIVE_WORKFLOW_MANAGER,
  BRIDGE_RUN_STARTED,
  clearSlot,
  CONTRACT_SLOT_KEYS,
  EXTENSION_HEALTH,
  EXTENSION_CONTRACT_VERSION,
  hasSlot,
  readOrInitSlot,
  readSlot,
  slotName,
  WIKI_INGEST_DISPATCHER,
  WIKI_REINDEX_DISPATCHER,
  WORKFLOW_EXTRA_TOOLSETS,
  WORKFLOW_MANAGER_REGISTRY,
  writeSlot,
} from "./extension-contract.ts";

describe("slot keys", () => {
  it("use the exact agreed strings", () => {
    // Changing any of these unhooks a participant silently. If a rename is
    // genuinely wanted, every consumer — including the out-of-tree wiki
    // package — has to move in the same commit.
    expect(ACTIVE_WORKFLOW_MANAGER.description).toBe(
      "semla.active-workflow-manager",
    );
    expect(WORKFLOW_EXTRA_TOOLSETS.description).toBe(
      "semla.workflow.extra-toolsets",
    );
    expect(WIKI_INGEST_DISPATCHER.description).toBe(
      "semla.wiki-ingest-dispatcher",
    );
    expect(WIKI_REINDEX_DISPATCHER.description).toBe(
      "semla.wiki-reindex-dispatcher",
    );
    expect(BRIDGE_RUN_STARTED.description).toBe("semla.bridge-run-started");
    expect(WORKFLOW_MANAGER_REGISTRY.description).toBe(
      "semla.workflow.managers",
    );
    expect(EXTENSION_HEALTH.description).toBe("semla.extension-health");
  });

  it("are registry symbols, so separate module scopes resolve the same slot", () => {
    for (const key of CONTRACT_SLOT_KEYS) {
      expect(Symbol.for(key.description!)).toBe(key);
    }
  });

  it("are all listed in CONTRACT_SLOT_KEYS", () => {
    expect(new Set(CONTRACT_SLOT_KEYS).size).toBe(CONTRACT_SLOT_KEYS.length);
    expect(CONTRACT_SLOT_KEYS).toHaveLength(8);
  });

  it("exposes a contract version", () => {
    expect(EXTENSION_CONTRACT_VERSION).toBeGreaterThan(0);
  });
});

describe("slot accessors", () => {
  afterEach(() => {
    for (const key of CONTRACT_SLOT_KEYS) clearSlot(key);
  });

  it("round-trips a value through globalThis", () => {
    expect(readSlot(WORKFLOW_EXTRA_TOOLSETS)).toBeUndefined();
    expect(hasSlot(WORKFLOW_EXTRA_TOOLSETS)).toBe(false);

    const toolsets = { "wiki-synthesis:1": () => [] };
    writeSlot(WORKFLOW_EXTRA_TOOLSETS, toolsets);

    expect(hasSlot(WORKFLOW_EXTRA_TOOLSETS)).toBe(true);
    expect(readSlot(WORKFLOW_EXTRA_TOOLSETS)).toBe(toolsets);
    // The point of Symbol.for: a foreign module scope reaching in by string
    // finds the same slot.
    expect(
      (globalThis as Record<symbol, unknown>)[
        Symbol.for("semla.workflow.extra-toolsets")
      ],
    ).toBe(toolsets);
  });

  it("clears a slot back to undefined", () => {
    writeSlot(BRIDGE_RUN_STARTED, () => {});
    clearSlot(BRIDGE_RUN_STARTED);
    expect(readSlot(BRIDGE_RUN_STARTED)).toBeUndefined();
    expect(hasSlot(BRIDGE_RUN_STARTED)).toBe(false);
  });

  it("initialises lazily only once", () => {
    let calls = 0;
    const init = () => {
      calls += 1;
      return new Map();
    };

    const first = readOrInitSlot(WORKFLOW_MANAGER_REGISTRY, init);
    const second = readOrInitSlot(WORKFLOW_MANAGER_REGISTRY, init);

    expect(first).toBe(second);
    expect(calls).toBe(1);
  });

  it("names slots for diagnostics", () => {
    expect(slotName(WIKI_INGEST_DISPATCHER)).toBe(
      "semla.wiki-ingest-dispatcher",
    );
  });
});
