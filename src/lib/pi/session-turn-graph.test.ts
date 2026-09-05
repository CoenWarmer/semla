/**
 * The property under test: turn-level grouping over the WHOLE tree, not the
 * live path — an abandoned branch must still produce nodes, or the graph this
 * feeds would have nothing to draw for it. See
 * docs/plans/branching-sessions.md §4.
 */
import { describe, expect, it } from "vitest";

import { buildTurnGraph } from "./session-turn-graph.ts";
import type { SessionFileEntry } from "./session-file.ts";

const user = (id: string, at: string, parentId: string | null, text = "hi") => ({
  id,
  message: { content: [{ text, type: "text" }], role: "user" },
  parentId,
  timestamp: at,
  type: "message",
});

const assistant = (
  id: string,
  at: string,
  parentId: string | null,
  text = "",
  extra: {
    toolCalls?: number;
    usage?: { cost?: number; totalTokens?: number };
  } = {},
) => ({
  id,
  message: {
    content: [
      { text, type: "text" },
      ...Array.from({ length: extra.toolCalls ?? 0 }, (_, i) => ({
        name: `tool${i}`,
        type: "toolCall",
      })),
    ],
    role: "assistant",
    ...(extra.usage
      ? {
          usage: {
            cost: { total: extra.usage.cost ?? 0 },
            totalTokens: extra.usage.totalTokens ?? 0,
          },
        }
      : {}),
  },
  parentId,
  timestamp: at,
  type: "message",
});

const toolResult = (id: string, at: string, parentId: string | null) => ({
  id,
  parentId,
  timestamp: at,
  type: "custom",
});

describe("buildTurnGraph", () => {
  it("returns nothing for an empty session", () => {
    expect(buildTurnGraph([])).toEqual({ edges: [], nodes: [], truncated: false });
  });

  it("makes one node per user message on a linear session", () => {
    const entries: SessionFileEntry[] = [
      user("a", "t1", null, "first ask"),
      assistant("b", "t2", "a"),
      user("c", "t3", "b", "second ask"),
      assistant("d", "t4", "c"),
    ];

    const graph = buildTurnGraph(entries);

    expect(graph.nodes.map((n) => n.id)).toEqual(["a", "c"]);
    expect(graph.edges).toEqual([{ from: "a", to: "c" }]);
  });

  it("folds every entry under the reply into the turn it belongs to", () => {
    const entries: SessionFileEntry[] = [
      user("a", "t1", null, "ask"),
      assistant("b", "t2", "a"),
      toolResult("c", "t3", "b"),
      assistant("d", "t4", "c"),
    ];

    const graph = buildTurnGraph(entries);

    expect(graph.nodes).toHaveLength(1);
    expect(graph.nodes[0]!.entryCount).toBe(4);
  });

  it("marks a node with more than one child as a fork", () => {
    const entries: SessionFileEntry[] = [
      user("a", "t1", null, "ask"),
      assistant("b1", "t2", "a"),
      user("c1", "t3", "b1", "abandoned follow-up"),
      assistant("b2", "t4", "a"),
      user("c2", "t5", "b2", "live follow-up"),
    ];

    const graph = buildTurnGraph(entries);

    const root = graph.nodes.find((n) => n.id === "a")!;
    expect(root.isFork).toBe(true);
    expect(graph.nodes.map((n) => n.id).sort()).toEqual(["a", "c1", "c2"]);
  });

  it("marks the default live path, following pi's own leaf rule", () => {
    const entries: SessionFileEntry[] = [
      user("a", "t1", null, "ask"),
      assistant("b1", "t2", "a"),
      user("c1", "t3", "b1", "abandoned"),
      assistant("b2", "t4", "a"),
      user("c2", "t5", "b2", "live"),
    ];

    const graph = buildTurnGraph(entries);

    expect(graph.nodes.find((n) => n.id === "c1")!.isLive).toBe(false);
    expect(graph.nodes.find((n) => n.id === "c2")!.isLive).toBe(true);
  });

  it("gives entries before any user message a synthetic root turn", () => {
    const entries: SessionFileEntry[] = [
      { id: "m", parentId: null, timestamp: "t0", type: "model_change" },
      user("a", "t1", "m", "ask"),
    ];

    const graph = buildTurnGraph(entries);

    expect(graph.nodes.map((n) => n.id)).toEqual(["\u2039root\u203a", "a"]);
    expect(graph.edges).toEqual([{ from: "\u2039root\u203a", to: "a" }]);
    expect(graph.nodes[0]!.promptText).toBeNull();
  });

  it("labels a node with the first non-empty line of the prompt", () => {
    const entries: SessionFileEntry[] = [
      user("a", "t1", null, "\n\n  first line  \nsecond line"),
    ];

    expect(buildTurnGraph(entries).nodes[0]!.promptText).toBe("first line");
  });

  it("does not hang on a parent cycle between user messages", () => {
    const entries: SessionFileEntry[] = [
      user("a", "t1", "b", "ask a"),
      user("b", "t2", "a", "ask b"),
    ];

    expect(() => buildTurnGraph(entries)).not.toThrow();
  });

  it("does not hang on a parent cycle among non-head entries, which recurses", () => {
    // Unlike the user-message case above, resolveHead recurses through
    // non-message entries to find the nearest head — a cycle here would
    // otherwise recurse forever.
    const entries: SessionFileEntry[] = [
      toolResult("x", "t1", "y"),
      toolResult("y", "t2", "x"),
    ];

    expect(() => buildTurnGraph(entries)).not.toThrow();
  });

  it("counts tool calls across every reply the turn folds in", () => {
    const entries: SessionFileEntry[] = [
      user("a", "t1", null, "ask"),
      assistant("b", "t2", "a", "looking", { toolCalls: 2 }),
      toolResult("c", "t3", "b"),
      assistant("d", "t4", "c", "done", { toolCalls: 1 }),
    ];

    expect(buildTurnGraph(entries).nodes[0]!.toolCallCount).toBe(3);
  });

  it("sums tokens and cost from assistant usage, ignoring entries with none", () => {
    const entries: SessionFileEntry[] = [
      user("a", "t1", null, "ask"),
      assistant("b", "t2", "a", "looking", {
        usage: { cost: 0.02, totalTokens: 500 },
      }),
      toolResult("c", "t3", "b"),
      assistant("d", "t4", "c", "done", {
        usage: { cost: 0.03, totalTokens: 800 },
      }),
    ];

    const node = buildTurnGraph(entries).nodes[0]!;
    expect(node.tokens).toBe(1300);
    expect(node.cost).toBeCloseTo(0.05);
  });

  it("does not count a user message's own content as a tool call or usage", () => {
    const entries: SessionFileEntry[] = [user("a", "t1", null, "ask")];

    const node = buildTurnGraph(entries).nodes[0]!;
    expect(node.toolCallCount).toBe(0);
    expect(node.tokens).toBe(0);
    expect(node.cost).toBe(0);
  });

  it("gives the synthetic root turn zeroed usage fields rather than undefined", () => {
    const entries: SessionFileEntry[] = [
      { id: "m", parentId: null, timestamp: "t0", type: "model_change" },
      user("a", "t1", "m", "ask"),
    ];

    const root = buildTurnGraph(entries).nodes[0]!;
    expect(root.toolCallCount).toBe(0);
    expect(root.tokens).toBe(0);
    expect(root.cost).toBe(0);
  });

  it("keeps two turns' usage totals separate rather than accumulating one running total", () => {
    const entries: SessionFileEntry[] = [
      user("a", "t1", null, "first"),
      assistant("b", "t2", "a", "", {
        toolCalls: 1,
        usage: { cost: 0.01, totalTokens: 100 },
      }),
      user("c", "t3", "b", "second"),
      assistant("d", "t4", "c", "", {
        toolCalls: 2,
        usage: { cost: 0.02, totalTokens: 200 },
      }),
    ];

    const graph = buildTurnGraph(entries);
    const first = graph.nodes.find((n) => n.id === "a")!;
    const second = graph.nodes.find((n) => n.id === "c")!;

    expect(first.toolCallCount).toBe(1);
    expect(first.tokens).toBe(100);
    expect(first.cost).toBeCloseTo(0.01);

    // Not 3 / 300 / 0.03 — each turn's own reply only, not a cumulative sum
    // carried forward from the turn before it.
    expect(second.toolCallCount).toBe(2);
    expect(second.tokens).toBe(200);
    expect(second.cost).toBeCloseTo(0.02);
  });
});
