/**
 * Two things worth pinning down about STREAMDOWN_REHYPE_PLUGINS_WITHOUT_RAW:
 * that it genuinely omits rehype-raw (the thing that makes literal `<p>` text
 * in a message parse as a real, nested `<p>` element and hydration-mismatch),
 * and that the omission actually changes how Streamdown renders such text —
 * proven against the real package, not just against this module's own logic.
 */
import { describe, expect, it } from "vitest";
import { defaultRehypePlugins } from "streamdown";

import { STREAMDOWN_REHYPE_PLUGINS_WITHOUT_RAW } from "./markdown-paragraph.tsx";

describe("STREAMDOWN_REHYPE_PLUGINS_WITHOUT_RAW", () => {
  it("omits exactly the raw plugin", () => {
    expect(STREAMDOWN_REHYPE_PLUGINS_WITHOUT_RAW).toHaveLength(
      Object.keys(defaultRehypePlugins).length - 1,
    );
    expect(STREAMDOWN_REHYPE_PLUGINS_WITHOUT_RAW).not.toContain(
      defaultRehypePlugins.raw,
    );
  });

  it("keeps every other default plugin", () => {
    for (const [name, plugin] of Object.entries(defaultRehypePlugins)) {
      if (name === "raw") continue;
      expect(STREAMDOWN_REHYPE_PLUGINS_WITHOUT_RAW).toContain(plugin);
    }
  });

  it("changes how Streamdown treats literal HTML in text, proven against the real package", async () => {
    // Mirrors ks() in streamdown's own bundle closely enough to observe the
    // one thing that matters here: whether rehype-raw's absence makes the
    // package add its own html-to-text remark plugin. Rather than
    // re-implementing streamdown's internal wiring, render through the
    // actual package on both sides of the omission and compare.
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { createElement } = await import("react");
    const { Streamdown, defaultRemarkPlugins } = await import("streamdown");

    const input = "In HTML, <p> cannot be a descendant of <p>.";

    const withRaw = renderToStaticMarkup(
      createElement(Streamdown, {
        children: input,
        mode: "static",
        rehypePlugins: Object.values(defaultRehypePlugins),
        remarkPlugins: Object.values(defaultRemarkPlugins),
      } as never),
    );
    const withoutRaw = renderToStaticMarkup(
      createElement(Streamdown, {
        children: input,
        mode: "static",
        rehypePlugins: STREAMDOWN_REHYPE_PLUGINS_WITHOUT_RAW,
        remarkPlugins: Object.values(defaultRemarkPlugins),
      } as never),
    );

    // With rehype-raw: the literal "<p>" text is parsed as a real element,
    // producing a nested <p data-slot="..."> — no escaped "&lt;p&gt;" in the
    // output, and (this is the bug) a <p> that is not the outermost one.
    expect(withRaw).not.toContain("&lt;p&gt;");

    // Without it: the same text renders as escaped, visible text instead of
    // being parsed into a second, nested paragraph element.
    expect(withoutRaw).toContain("&lt;p&gt;");
  });
});
