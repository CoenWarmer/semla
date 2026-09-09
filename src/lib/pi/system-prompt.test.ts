/**
 * The constraint system-prompt.ts's docblock claims, now actually enforced.
 *
 * That file is rendered by the settings editor, a client component, so anything
 * it imports enters the browser bundle. It used to live in prompts.ts, which
 * reaches runtime-config.ts and from there @earendil-works/pi-coding-agent — so
 * the client graph pulled in child_process and the settings page failed to
 * compile at all. The docblock said "system-prompt.test.ts enforces that"; no
 * such file existed, so the rule was a comment.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { DEFAULT_SYSTEM_PROMPT } from "./system-prompt";

describe("system-prompt.ts", () => {
  it("imports nothing", () => {
    const source = readFileSync(
      join(process.cwd(), "src/lib/pi/system-prompt.ts"),
      "utf-8",
    );

    // Any import at all is the failure: the module is in a client bundle, and
    // the one that broke the settings page was two hops from anything obviously
    // server-only.
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/\brequire\(/);
  });

  it("names the tool for each kind of thing you already know", () => {
    // Measured before this line was added: bash was 4,004 tool calls across 120
    // sessions, 63% of it file inspection, while code_find was called twice and
    // supi's other five never. The prompt has to distinguish the cases, not
    // just advertise one tool.
    expect(DEFAULT_SYSTEM_PROMPT).toContain("grep");
    expect(DEFAULT_SYSTEM_PROMPT).toContain("code_search");
    expect(DEFAULT_SYSTEM_PROMPT).toContain("code_map");
  });
});
