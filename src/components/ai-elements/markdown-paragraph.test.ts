/**
 * The case from a real session: a workflow answered with
 *
 *     **1. Red Panda**
 *     ![Red Panda](https://…)
 *
 * which markdown makes one paragraph of `strong`, `br`, `img`. Streamdown
 * renders the image as a `div`, so that is a `div` inside a `p` — invalid, and
 * React reports it as a hydration error because the browser's parser closes
 * the `p` early and the two trees then disagree.
 */
import { createElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { paragraphTagFor } from "./markdown-paragraph.tsx";

/** An element shaped the way react-markdown hands them to a component. */
const node = (tagName: string, props: Record<string, unknown> = {}): ReactNode =>
  createElement("span", { key: tagName, node: { tagName }, ...props });

describe("paragraphTagFor", () => {
  it("keeps a p for ordinary text", () => {
    expect(paragraphTagFor("just words")).toBe("p");
    expect(paragraphTagFor([node("strong"), " and text"])).toBe("p");
  });

  it("collapses a lone image, as Streamdown already does", () => {
    expect(paragraphTagFor(node("img"))).toBe("fragment");
    expect(paragraphTagFor([node("img")])).toBe("fragment");
  });

  it("uses a div when an image sits beside other content", () => {
    // The reported case. A fragment would work too, but would drop the
    // paragraph's own styling.
    expect(
      paragraphTagFor([node("strong"), node("br"), node("img")]),
    ).toBe("div");
  });

  it("handles an image before the text as well as after", () => {
    expect(paragraphTagFor([node("img"), " a caption"])).toBe("div");
  });

  it("treats several images in one paragraph as a div", () => {
    expect(paragraphTagFor([node("img"), node("img")])).toBe("div");
  });

  it("collapses a lone fenced code block", () => {
    // Streamdown marks a block code child, and renders it as a div too.
    expect(paragraphTagFor(node("code", { "data-block": true }))).toBe(
      "fragment",
    );
  });

  it("leaves inline code in a p", () => {
    // No data-block: this is `like this`, which renders inline.
    expect(paragraphTagFor([node("code"), " inline"])).toBe("p");
  });

  it("ignores empty and nullish children when counting", () => {
    // Otherwise a lone image with a stray empty string beside it would be
    // treated as mixed content and gain a wrapper it does not need.
    expect(paragraphTagFor([null, node("img"), "", undefined])).toBe(
      "fragment",
    );
  });

  it("keeps a p for children that are not elements at all", () => {
    expect(paragraphTagFor([null, undefined, ""])).toBe("p");
    expect(paragraphTagFor(undefined)).toBe("p");
  });
});
