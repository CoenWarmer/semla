import { describe, expect, it } from "vitest";

import { parseTerminalControl } from "@/lib/terminal-control";

/**
 * This is the boundary a request body crosses on its way to `pty.write` and
 * `pty.resize` — the only place a browser reaches a real process — so what it
 * accepts is worth stating precisely.
 */
describe("parseTerminalControl", () => {
  it("takes keystrokes as they are, control characters included", () => {
    // \u0003 is Ctrl-C. Interrupting is a keystroke like any other — the shell
    // decides what it means, not this.
    expect(parseTerminalControl({ data: "\u0003", type: "input" })).toEqual({
      data: "\u0003",
      type: "input",
    });
    expect(parseTerminalControl({ data: "ls -la\r", type: "input" })).toEqual({
      data: "ls -la\r",
      type: "input",
    });
  });

  it("allows empty input rather than making the client special-case it", () => {
    expect(parseTerminalControl({ data: "", type: "input" })).toEqual({
      data: "",
      type: "input",
    });
  });

  it("refuses input that is not a string", () => {
    expect(parseTerminalControl({ data: 42, type: "input" })).toBeNull();
    expect(parseTerminalControl({ type: "input" })).toBeNull();
    expect(parseTerminalControl({ data: null, type: "input" })).toBeNull();
  });

  it("takes a plausible terminal size", () => {
    expect(parseTerminalControl({ cols: 120, rows: 40, type: "resize" })).toEqual({
      cols: 120,
      rows: 40,
      type: "resize",
    });
  });

  it("refuses a size an ioctl should never see", () => {
    // Zero, fractional, negative and absurd all reach the same syscall.
    expect(parseTerminalControl({ cols: 0, rows: 24, type: "resize" })).toBeNull();
    expect(parseTerminalControl({ cols: 80, rows: 0, type: "resize" })).toBeNull();
    expect(parseTerminalControl({ cols: -80, rows: 24, type: "resize" })).toBeNull();
    expect(parseTerminalControl({ cols: 80.5, rows: 24, type: "resize" })).toBeNull();
    expect(parseTerminalControl({ cols: 1e6, rows: 24, type: "resize" })).toBeNull();
    expect(parseTerminalControl({ cols: "80", rows: 24, type: "resize" })).toBeNull();
    expect(
      parseTerminalControl({ cols: Number.NaN, rows: 24, type: "resize" }),
    ).toBeNull();
  });

  it("takes a kill with nothing else to say", () => {
    expect(parseTerminalControl({ type: "kill" })).toEqual({ type: "kill" });
  });

  it("refuses anything it does not recognise", () => {
    expect(parseTerminalControl({ type: "exec", data: "rm -rf /" })).toBeNull();
    expect(parseTerminalControl({})).toBeNull();
    expect(parseTerminalControl(null)).toBeNull();
    expect(parseTerminalControl("input")).toBeNull();
    expect(parseTerminalControl([{ type: "kill" }])).toBeNull();
  });
});
