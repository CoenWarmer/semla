/**
 * Every button here declares its type, and the popover trigger is a real
 * <button>.
 *
 * The type matters because a bare <button> inside a <form> defaults to submit.
 * This badge shipped in the prompt toolbar, which is exactly such a form —
 * clicking "Merge in origin/main" would have sent whatever was in the textarea
 * — and although it now lives in the top bar, nothing stops it moving back.
 *
 * There is no DOM test setup in this project, and neither tsc nor eslint has
 * an opinion about a missing `type`, so this reads the source — the same
 * approach client-boundary.test.ts takes for a bug of similar invisibility.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Comments are stripped first. An earlier version of this test matched the
 * word "<button>" in the very comment explaining why a button was needed, and
 * so passed against a trigger that had been changed back to a <span>.
 */
const source = readFileSync(
  join(process.cwd(), "src/components/git-status-badge.tsx"),
  "utf-8",
)
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

describe("GitStatusBadge markup", () => {
  it("gives every button an explicit type", () => {
    const buttons = source.match(/<(?:button|Button)\b/g) ?? [];
    const typed = source.match(/type="button"/g) ?? [];
    expect(buttons.length).toBeGreaterThan(0);
    expect(typed).toHaveLength(buttons.length);
  });

  it("renders the popover trigger as a native button", () => {
    // Base UI warns when a component acting as a button is not one: it drops
    // the semantics keyboard and assistive tech depend on.
    const trigger = source.slice(
      source.indexOf("<PopoverTrigger"),
      source.indexOf("</PopoverTrigger>"),
    );
    expect(trigger).toContain("render=");
    expect(trigger).toContain("<button");
    expect(trigger).not.toContain("<span\n");
  });
});
