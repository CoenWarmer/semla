/**
 * Pins the linkage workflow-agent-transcript.ts depends on: a subagent's
 * transcript is found by the `session_info` name agent.ts writes, and parsed
 * with compactAgentHistory rather than a second mapping.
 *
 * The format assertion is the load-bearing one. Nothing else in the codebase
 * couples the producer (workflow.ts's `sessionName`) to this consumer, so a
 * change to either side would otherwise show up as an agent detail page that
 * silently falls back to the run file's tail — the exact failure this module
 * exists to fix, and one with no error attached to it.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  findAgentTranscript,
  readAgentHistoryFromTranscript,
  readAgentTranscript,
  subagentSessionName,
} from "./workflow-agent-transcript.ts";

let sessionDir: string;

beforeEach(() => {
  sessionDir = mkdtempSync(join(tmpdir(), "semla-transcript-"));
});

afterEach(() => {
  rmSync(sessionDir, { recursive: true, force: true });
});

/**
 * A transcript shaped the way pi writes one: header lines, then a body.
 *
 * Body items are message payloads, except for a `{ compaction: ... }` marker,
 * which is written as pi's own separate `compaction` entry type rather than as
 * a message — the distinction this module has to preserve.
 */
function writeTranscript(
  file: string,
  sessionName: string | null,
  body: unknown[],
  { trailingPartialLine = false } = {},
): string {
  const lines: string[] = [
    JSON.stringify({ type: "session", version: 3, id: "sess", cwd: "/repo" }),
    JSON.stringify({ type: "model_change", provider: "openrouter", modelId: "m" }),
  ];
  if (sessionName !== null) {
    lines.push(JSON.stringify({ type: "session_info", name: sessionName }));
  }
  for (const item of body) {
    const marker = (item as { compaction?: unknown })?.compaction;
    lines.push(
      JSON.stringify(
        marker
          ? { type: "compaction", timestamp: "2026-09-09T14:30:00.000Z", ...marker }
          : { type: "message", message: item },
      ),
    );
  }

  let content = `${lines.join("\n")}\n`;
  if (trailingPartialLine) content += '{"type":"message","message":{"role":"assi';

  const path = join(sessionDir, file);
  writeFileSync(path, content);
  return path;
}

const compaction = (summary: string, tokensBefore?: number) => ({
  compaction: { summary, tokensBefore },
});

const userMessage = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
const assistantMessage = (text: string) => ({
  role: "assistant",
  content: [{ type: "text", text }],
});

describe("subagentSessionName", () => {
  // Pins the format against workflow.ts's `sessionName: \`workflow:${runId} ${label}\``.
  it("is the run id and label, space separated, under a workflow: prefix", () => {
    expect(subagentSessionName("run-abc", "implement")).toBe("workflow:run-abc implement");
  });
});

describe("findAgentTranscript", () => {
  it("finds the transcript whose session_info names this run and label", () => {
    writeTranscript("a.jsonl", subagentSessionName("run-1", "other"), [userMessage("x")]);
    const wanted = writeTranscript("b.jsonl", subagentSessionName("run-1", "implement"), [
      userMessage("x"),
    ]);

    expect(findAgentTranscript("run-1", "implement", sessionDir)).toBe(wanted);
  });

  it("does not confuse two runs that share a label", () => {
    writeTranscript("a.jsonl", subagentSessionName("run-1", "implement"), [userMessage("x")]);
    const wanted = writeTranscript("b.jsonl", subagentSessionName("run-2", "implement"), [
      userMessage("x"),
    ]);

    expect(findAgentTranscript("run-2", "implement", sessionDir)).toBe(wanted);
  });

  it("returns null when no transcript carries that name", () => {
    writeTranscript("a.jsonl", subagentSessionName("run-1", "other"), [userMessage("x")]);

    expect(findAgentTranscript("run-1", "implement", sessionDir)).toBeNull();
  });

  // The main session's own transcript and its .spans.jsonl sidecar sit in this
  // same directory and carry no session_info name.
  it("ignores files with no session_info entry", () => {
    writeTranscript("main.jsonl", null, [userMessage("x")]);

    expect(findAgentTranscript("run-1", "implement", sessionDir)).toBeNull();
  });

  it("returns null when the session directory does not exist", () => {
    expect(findAgentTranscript("run-1", "implement", join(sessionDir, "nope"))).toBeNull();
  });
});

describe("readAgentTranscript", () => {
  it("maps message entries through compactAgentHistory", () => {
    const path = writeTranscript("a.jsonl", subagentSessionName("run-1", "implement"), [
      userMessage("do the thing"),
      assistantMessage("done"),
    ]);

    const history = readAgentTranscript(path);

    expect(history).toEqual([
      { role: "user", kind: "text", text: "do the thing", timestamp: undefined, diff: undefined },
      { role: "assistant", kind: "text", text: "done", timestamp: undefined, diff: undefined },
    ]);
  });

  // A transcript is appended to while the agent runs, so a read that lands
  // mid-write legitimately sees a half-written final line.
  it("keeps the entries that parsed when the file ends mid-write", () => {
    const path = writeTranscript(
      "a.jsonl",
      subagentSessionName("run-1", "implement"),
      [userMessage("do the thing"), assistantMessage("done")],
      { trailingPartialLine: true },
    );

    expect(readAgentTranscript(path)).toHaveLength(2);
  });

  it("returns null for a transcript holding no messages", () => {
    const path = writeTranscript("a.jsonl", subagentSessionName("run-1", "implement"), []);

    expect(readAgentTranscript(path)).toBeNull();
  });

  it("returns null for a file that cannot be read", () => {
    expect(readAgentTranscript(join(sessionDir, "absent.jsonl"))).toBeNull();
  });

  /**
   * The transcript is append-only, so it keeps what came BEFORE a compaction
   * as well as after. Dropping the marker leaves those two stretches reading
   * as one continuous conversation the agent never actually had — which is the
   * same wrong-by-omission failure the run file's truncated tail produces.
   */
  describe("compaction", () => {
    it("keeps the compaction in position between the messages it separates", () => {
      const path = writeTranscript("a.jsonl", subagentSessionName("run-1", "long"), [
        userMessage("first"),
        compaction("summary of the above", 128_000),
        assistantMessage("after"),
      ]);

      const history = readAgentTranscript(path);

      expect(history?.map((e) => e.kind)).toEqual(["text", "compaction", "text"]);
    });

    it("carries the summary and the context size it dropped", () => {
      const path = writeTranscript("a.jsonl", subagentSessionName("run-1", "long"), [
        compaction("summary of the above", 128_000),
      ]);

      const [entry] = readAgentTranscript(path) ?? [];

      expect(entry).toMatchObject({
        role: "system",
        kind: "compaction",
        text: "summary of the above",
        tokensBefore: 128_000,
      });
    });

    it("survives a compaction entry that reports no token count", () => {
      const path = writeTranscript("a.jsonl", subagentSessionName("run-1", "long"), [
        compaction("summary only"),
      ]);

      const [entry] = readAgentTranscript(path) ?? [];

      expect(entry?.kind).toBe("compaction");
      expect(entry?.tokensBefore).toBeUndefined();
    });
  });
});

describe("readAgentHistoryFromTranscript", () => {
  it("resolves and reads in one step", () => {
    writeTranscript("a.jsonl", subagentSessionName("run-1", "implement"), [
      userMessage("do the thing"),
    ]);

    const history = readAgentHistoryFromTranscript("run-1", "implement", sessionDir);

    expect(history).toHaveLength(1);
    expect(history?.[0].text).toBe("do the thing");
  });

  it("is null when the agent has no persisted transcript", () => {
    expect(readAgentHistoryFromTranscript("run-1", "implement", sessionDir)).toBeNull();
  });

  /**
   * The whole point of preferring the transcript: the run file's history is
   * fitted to 40 entries, so an agent with more than that in its transcript is
   * exactly the case where the two records disagree.
   */
  it("returns far more than the run file's 40-entry cap allows", () => {
    const messages = Array.from({ length: 120 }, (_, i) => assistantMessage(`step ${i}`));
    writeTranscript("a.jsonl", subagentSessionName("run-1", "long"), messages);

    expect(readAgentHistoryFromTranscript("run-1", "long", sessionDir)).toHaveLength(120);
  });
});
