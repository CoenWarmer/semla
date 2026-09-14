import { describe, expect, it } from "vitest";

import { renderEnforcementFeedback, runEnforcementCommand } from "./enforcement-loop";

describe("runEnforcementCommand", () => {
  it("skips when no command is configured", async () => {
    expect(await runEnforcementCommand(undefined, process.cwd())).toEqual({ ran: false });
    expect(await runEnforcementCommand("   ", process.cwd())).toEqual({ ran: false });
  });

  it("reports success with output for a passing command", async () => {
    const result = await runEnforcementCommand("echo ok", process.cwd());
    expect(result.ran).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("ok");
  });

  it("reports a non-zero exit code and captures output for a failing command", async () => {
    const result = await runEnforcementCommand("echo boom && exit 1", process.cwd());
    expect(result.ran).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(result.output).toBe("boom");
  });
});

describe("renderEnforcementFeedback", () => {
  it("renders nothing when the command did not run", () => {
    expect(renderEnforcementFeedback({ ran: false })).toBe("");
  });

  it("renders nothing for a passing command with no output", () => {
    expect(renderEnforcementFeedback({ command: "true", exitCode: 0, output: "", ran: true })).toBe("");
  });

  it("renders passing output when present", () => {
    const text = renderEnforcementFeedback({
      command: "lint",
      exitCode: 0,
      output: "0 problems",
      ran: true,
    });
    expect(text).toContain("[enforcement: lint]");
    expect(text).toContain("0 problems");
  });

  it("renders a failure block feeding output back as a normal tool result, not a fatal error", () => {
    const text = renderEnforcementFeedback({
      command: "lint",
      exitCode: 2,
      output: "3 boundary violations",
      ran: true,
    });
    expect(text).toContain("[enforcement FAILED: lint exited 2]");
    expect(text).toContain("3 boundary violations");
  });
});
