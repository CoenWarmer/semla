import { createElement } from "react";
import { describe, expect, it } from "vitest";

const MARKDOWN = `Both lists overlapped on three animals — **Red Panda**, **Quokka** — so those are the top 3.

**1. Red Panda**
![Red Panda](https://upload.wikimedia.org/wikipedia/commons/thumb/6/68/x.jpg)

**2. Quokka**
![Quokka](https://upload.wikimedia.org/wikipedia/commons/thumb/9/9b/y.jpg)
`;

/** Every <p>…</p> that contains a <div, which is the invalid nesting. */
const badParagraphs = (html: string): string[] =>
  [...html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/g)]
    .filter((m) => m[1].includes("<div"))
    .map((m) => m[0].slice(0, 90));

/**
 * Renders the real thing through the real Streamdown, because the unit test
 * above checks a decision about a tree I described rather than the HTML the
 * library actually emits.
 *
 * The first assertion is a tripwire on purpose: it asserts the upstream bug is
 * still there. When a streamdown release fixes it, this fails and says so,
 * which is the signal to delete the override rather than carry it forever.
 */
describe("the reported markdown", () => {
  it("renders no div inside a p once p is overridden", async () => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { Streamdown } = await import("streamdown");
    const { MarkdownParagraph } = await import("./markdown-paragraph.tsx");

    const render = (components?: Record<string, unknown>) =>
      renderToStaticMarkup(
        createElement(Streamdown, { children: MARKDOWN, components } as never),
      );

    const before = render(undefined);
    const after = render({ p: MarkdownParagraph });

    // The bug, then its absence — asserting both so a streamdown release that
    // fixes it upstream makes this test say so rather than silently passing.
    expect(badParagraphs(before).length).toBeGreaterThan(0);
    // Both images must survive; a fragment or div wrapper must not drop one.
    expect((after.match(/<img/g) ?? []).length).toBe(
      (before.match(/<img/g) ?? []).length,
    );
    expect(after).toContain("Red Panda");
    expect(badParagraphs(after)).toEqual([]);
  }, 120_000);
});
