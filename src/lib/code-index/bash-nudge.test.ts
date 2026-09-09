/**
 * When the index makes itself known, and — more importantly — when it keeps
 * quiet. A hint on every grep becomes wallpaper, and a hint after a search that
 * worked is simply wrong: an exact identifier lookup is a job grep does better.
 */

import { describe, expect, it } from "vitest";

import { MAX_NUDGES_PER_SESSION, nudgeFor, TOO_MANY_MATCHES } from "./bash-nudge";

const base = { indexed: true, alreadyNudged: 0 };

describe("nudgeFor", () => {
  it("speaks up when a search matched nothing", () => {
    const nudge = nudgeFor({ ...base, command: 'grep -rn "retryBudget" src', output: "" });
    expect(nudge).toMatch(/matched nothing/);
    expect(nudge).toMatch(/code_search/);
  });

  it("speaks up when a search matched far too much", () => {
    const nudge = nudgeFor({
      ...base,
      command: 'rg -n "export" src',
      output: Array.from({ length: TOO_MANY_MATCHES + 5 }, (_, i) => `src/a.ts:${i}: export`).join("\n"),
    });
    expect(nudge).toMatch(/too much/);
  });

  /**
   * The case that matters most. `grep -rl "some_exact_flag"` finding three
   * files is the right tool used correctly; suggesting a vector search whose
   * scores do not separate good hits from bad would be worse advice.
   */
  it("stays quiet when the search worked", () => {
    expect(
      nudgeFor({
        ...base,
        command: 'grep -rl "phase_bar_terminal_fix_2" .',
        output: "src/a.ts\nsrc/b.ts\nsrc/c.ts",
      }),
    ).toBeNull();
  });

  it("stays quiet when the project has no index", () => {
    expect(
      nudgeFor({ ...base, indexed: false, command: 'grep -rn "x" src', output: "" }),
    ).toBeNull();
  });

  it("stays quiet once the session cap is reached", () => {
    const input = { ...base, command: 'grep -rn "x" src', output: "" };
    expect(nudgeFor({ ...input, alreadyNudged: MAX_NUDGES_PER_SESSION - 1 })).not.toBeNull();
    expect(nudgeFor({ ...input, alreadyNudged: MAX_NUDGES_PER_SESSION })).toBeNull();
  });

  it("stays quiet for commands that are not searches", () => {
    for (const command of ["npm run tsc", "git show --stat HEAD", "sed -n '1,40p' src/a.ts", "ls src"]) {
      expect(nudgeFor({ ...base, command, output: "" })).toBeNull();
    }
  });

  it("recognises a search later in a pipeline", () => {
    expect(
      nudgeFor({ ...base, command: 'cat src/a.ts | grep "thing"', output: "" }),
    ).not.toBeNull();
    expect(
      nudgeFor({ ...base, command: 'cd /repo && rg "thing" src', output: "" }),
    ).not.toBeNull();
  });

  /**
   * A grep through dependencies or recorded sessions is not a question about
   * this project's source, so the index has no answer to offer.
   */
  it("stays quiet for searches outside the project's own source", () => {
    for (const command of [
      'grep -rn "foo" node_modules/@some/pkg',
      'grep -l "toolName" .semla-sessions',
      'rg "x" .next',
    ]) {
      expect(nudgeFor({ ...base, command, output: "" })).toBeNull();
    }
  });
});
