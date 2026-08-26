import { describe, expect, it } from "vitest";

import {
  formatLoggedOutput,
  formatResultSection,
  RETURNLESS_SCRIPT_NOTICE,
} from "./result-text.ts";

const PERSIST_LOG = "Logs persisted to /home/u/.pi/workflows/runs/run-1.log";

describe("formatResultSection", () => {
  it("renders a returned value as a JSON block", () => {
    const section = formatResultSection({ summary: "9 of 10 matched" });

    expect(section).toBe(
      '## Result\n```json\n{\n  "summary": "9 of 10 matched"\n}\n```',
    );
    expect(section).not.toContain(RETURNLESS_SCRIPT_NOTICE);
  });

  it("renders falsy returned values instead of treating them as absent", () => {
    expect(formatResultSection(null)).toContain("```json\nnull\n```");
    expect(formatResultSection(0)).toContain("```json\n0\n```");
    expect(formatResultSection("")).toContain('```json\n""\n```');
  });

  it("explains the mistake when the script returned nothing", () => {
    const section = formatResultSection(undefined);

    expect(section).toBe(`## Result\n\n${RETURNLESS_SCRIPT_NOTICE}`);
  });

  it("falls back to logged output so a returnless run still hands back its work", () => {
    // The shape that caused the duplicate run: every list went to log(), and the
    // script ended in a bare `summary;` expression instead of `return summary`.
    const section = formatResultSection(undefined, [
      "Agent 1:\nPuppies\nKittens",
      "Agent 2:\nPanda\nRed panda",
      "Summary:\n6 overlapping animals.",
      PERSIST_LOG,
    ]);

    expect(section).toContain(RETURNLESS_SCRIPT_NOTICE);
    expect(section).toContain("### Logged output");
    expect(section).toContain("do not re-run the workflow");
    expect(section).toContain("Summary:\n6 overlapping animals.");
    expect(section).not.toContain(PERSIST_LOG);
  });
});

describe("formatLoggedOutput", () => {
  it("returns undefined when the script logged nothing of its own", () => {
    expect(formatLoggedOutput([])).toBeUndefined();
    expect(formatLoggedOutput([PERSIST_LOG])).toBeUndefined();
    expect(formatLoggedOutput(["", "   \n "])).toBeUndefined();
  });

  it("joins entries with a blank line between them", () => {
    expect(formatLoggedOutput(["first", "second"])).toBe("first\n\nsecond");
  });

  it("caps long output and reports how much it dropped", () => {
    const capped = formatLoggedOutput(["x".repeat(50)], 20);

    expect(capped).toBe(
      `${"x".repeat(20)}\n…(truncated 30 chars — the full log is in the run file)`,
    );
  });

  it("leaves output at exactly the cap untouched", () => {
    expect(formatLoggedOutput(["x".repeat(20)], 20)).toBe("x".repeat(20));
  });
});
