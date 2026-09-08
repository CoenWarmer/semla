import { describe, expect, it } from "vitest";

import { FILE_LINK_MARKER, parseFileLinkHref, rehypeFileLinks } from "./rehype-file-links";

import type { Element, Root } from "hast";

function anchor(href: string, text = "link"): Element {
  return {
    children: [{ type: "text", value: text }],
    properties: { href },
    tagName: "a",
    type: "element",
  };
}

function paragraph(...children: Element[]): Root {
  return {
    children: [
      {
        children,
        properties: {},
        tagName: "p",
        type: "element",
      },
    ],
    type: "root",
  };
}

describe("parseFileLinkHref", () => {
  it("parses a plain repo-relative source file", () => {
    expect(parseFileLinkHref("src/lib/session-live-state.ts")).toEqual({
      line: null,
      rawPath: "src/lib/session-live-state.ts",
    });
  });

  it("parses a trailing line number", () => {
    expect(parseFileLinkHref("src/lib/foo.ts:42")).toEqual({
      line: 42,
      rawPath: "src/lib/foo.ts",
    });
  });

  it("tolerates a leading ./", () => {
    expect(parseFileLinkHref("./src/lib/foo.ts")).toEqual({
      line: null,
      rawPath: "src/lib/foo.ts",
    });
  });

  it("rejects an absolute URL", () => {
    expect(parseFileLinkHref("https://example.com")).toBeNull();
  });

  it("rejects a javascript: URL", () => {
    expect(parseFileLinkHref("javascript:alert(1)")).toBeNull();
  });

  it("rejects an absolute filesystem path", () => {
    expect(parseFileLinkHref("/Users/coen/abs/path.ts")).toBeNull();
  });

  it("rejects a path that climbs out with ..", () => {
    expect(parseFileLinkHref("src/../etc/passwd")).toBeNull();
  });

  it("rejects a path with no recognized code extension", () => {
    expect(parseFileLinkHref("src/dev/bar/baz")).toBeNull();
  });
});

describe("rehypeFileLinks", () => {
  it("rewrites a file-link anchor into a marked span carrying the path", () => {
    const tree = paragraph(anchor("src/lib/session-live-state.ts", "Foo"));
    rehypeFileLinks()(tree);

    const [p] = tree.children;
    const [span] = (p as Element).children as Element[];

    expect(span.tagName).toBe("span");
    expect(span.properties).toEqual({
      dataFileLink: FILE_LINK_MARKER,
      dataFilePath: "src/lib/session-live-state.ts",
    });
    expect(span.children).toEqual([{ type: "text", value: "Foo" }]);
  });

  it("rewrites a file-link anchor with a line number, keeping it as a data attribute", () => {
    const tree = paragraph(anchor("src/lib/foo.ts:42", "Foo"));
    rehypeFileLinks()(tree);

    const [p] = tree.children;
    const [span] = (p as Element).children as Element[];

    expect(span.properties).toEqual({
      dataFileLine: 42,
      dataFileLink: FILE_LINK_MARKER,
      dataFilePath: "src/lib/foo.ts",
    });
  });

  it("rewrites a file-link anchor written with a leading ./", () => {
    const tree = paragraph(anchor("./src/lib/foo.ts", "Foo"));
    rehypeFileLinks()(tree);

    const [p] = tree.children;
    const [span] = (p as Element).children as Element[];

    expect(span.tagName).toBe("span");
    expect(span.properties.dataFilePath).toBe("src/lib/foo.ts");
  });

  it("leaves a real URL untouched", () => {
    const tree = paragraph(anchor("https://example.com", "bar"));
    rehypeFileLinks()(tree);

    const [p] = tree.children;
    const [link] = (p as Element).children as Element[];

    expect(link.tagName).toBe("a");
    expect(link.properties).toEqual({ href: "https://example.com" });
  });

  it("leaves a javascript: URL untouched", () => {
    const tree = paragraph(anchor("javascript:alert(1)", "baz"));
    rehypeFileLinks()(tree);

    const [p] = tree.children;
    const [link] = (p as Element).children as Element[];

    expect(link.tagName).toBe("a");
    expect(link.properties.href).toBe("javascript:alert(1)");
  });

  it("leaves an absolute filesystem path untouched", () => {
    const tree = paragraph(anchor("/Users/coen/abs/path.ts", "abs"));
    rehypeFileLinks()(tree);

    const [p] = tree.children;
    const [link] = (p as Element).children as Element[];

    expect(link.tagName).toBe("a");
  });

  it("leaves a path that climbs out with .. untouched", () => {
    const tree = paragraph(anchor("src/../etc/passwd.ts", "dotdot"));
    rehypeFileLinks()(tree);

    const [p] = tree.children;
    const [link] = (p as Element).children as Element[];

    expect(link.tagName).toBe("a");
  });

  it("leaves an extensionless path untouched", () => {
    const tree = paragraph(anchor("src/dev/bar/baz", "noext"));
    rehypeFileLinks()(tree);

    const [p] = tree.children;
    const [link] = (p as Element).children as Element[];

    expect(link.tagName).toBe("a");
  });

  it("recurses into nested elements", () => {
    const tree: Root = {
      children: [
        {
          children: [
            {
              children: [anchor("src/lib/foo.ts", "Foo")],
              properties: {},
              tagName: "strong",
              type: "element",
            },
          ],
          properties: {},
          tagName: "p",
          type: "element",
        },
      ],
      type: "root",
    };

    rehypeFileLinks()(tree);

    const [p] = tree.children;
    const [strong] = (p as Element).children as Element[];
    const [span] = strong.children as Element[];

    expect(span.tagName).toBe("span");
    expect(span.properties.dataFilePath).toBe("src/lib/foo.ts");
  });
});
