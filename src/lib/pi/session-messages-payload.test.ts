/**
 * The transcript response is now the only source for the context-window bar,
 * which makes two previously-harmless habits into bugs.
 *
 * Both failures are invisible to the type checker: `systemPromptChars` is
 * optional, and the server-rendered payload was structurally valid — it just
 * said `contextWindow: null`. The bar read that as "window size unknown",
 * dropped to proportional mode, and drew itself completely full.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const read = (file: string) => readFileSync(join(process.cwd(), file), "utf8");

describe("the transcript payload has one builder", () => {
  const consumers = [
    // Serves it to the client.
    "src/app/api/sessions/[id]/messages/route.ts",
    // Seeds it as initialData, which a fresh query does not refetch past — so
    // a field this one omits is missing on screen, not merely late.
    "src/app/sessions/[id]/page.tsx",
  ];

  it.each(consumers)("%s builds it with buildSessionMessages", (file) => {
    expect(read(file)).toContain("buildSessionMessages");
  });

  it("the page does not hand-build a partial payload", () => {
    const source = read("src/app/sessions/[id]/page.tsx");
    // It used to spread a transcript over `{ contextWindow: null }`, which is
    // exactly the shape that broke the bar.
    expect(source).not.toMatch(/contextWindow:\s*null/);
  });
});

describe("optimistic writes to the transcript cache", () => {
  it("every one of them carries systemPromptChars through", () => {
    const source = read("src/hooks/use-prompt-mutation.ts");

    // These writes rebuild the whole cache entry rather than patching it, so a
    // field none of them mentions is silently dropped for the rest of the turn.
    const writes = source.split("setQueryData<SessionMessagesResult>").slice(1);

    expect(writes.length).toBeGreaterThan(0);
    for (const write of writes) {
      const body = write.slice(0, 600);
      expect(
        body.includes("systemPromptChars"),
        "a setQueryData<SessionMessagesResult> call rebuilds the entry without " +
          "systemPromptChars; the context-window bar reads it, so the bar " +
          "empties mid-turn.",
      ).toBe(true);
    }
  });
});
