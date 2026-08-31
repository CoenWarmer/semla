/**
 * Renders a laid-out graph to SVG, and to PNG when ImageMagick is present.
 *
 * The point of the PNG is that node labels stay legible — a full-vault
 * screenshot is unreadable at 377 nodes, so `crop` narrows to a region in
 * layout coordinates and the labels grow to fit.
 */

import { execFileSync } from "node:child_process";

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ImageMagick's SVG renderer needs an explicit font file or it errors out.
const FONT = "/System/Library/Fonts/Supplemental/Arial.ttf";

export function renderSvg(graph, nodes, { size = 2000, labels = "hubs", crop = null, caption = "" } = {}) {
  const pad = 40;

  const [x0, y0, x1, y1] = crop
    ? crop.split(",").map(Number)
    : [
        Math.min(...nodes.map((n) => n.x)), Math.min(...nodes.map((n) => n.y)),
        Math.max(...nodes.map((n) => n.x)), Math.max(...nodes.map((n) => n.y)),
      ];
  const span = Math.max(x1 - x0, y1 - y0) || 1;
  const scale = (size - pad * 2) / span;
  const px = (x) => pad + (x - x0) * scale;
  const py = (y) => pad + (y - y0) * scale;

  const visible = nodes.filter((n) => n.x >= x0 && n.x <= x1 && n.y >= y0 && n.y <= y1);
  const visibleIds = new Set(visible.map((n) => n.id));

  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`,
    `<rect width="${size}" height="${size}" fill="#0b1020"/>`,
  ];

  graph.forEachEdge((_e, _a, s, t) => {
    if (!visibleIds.has(s) || !visibleIds.has(t)) return;
    const A = graph.getNodeAttributes(s);
    const B = graph.getNodeAttributes(t);
    parts.push(
      `<line x1="${px(A.x).toFixed(1)}" y1="${py(A.y).toFixed(1)}" ` +
        `x2="${px(B.x).toFixed(1)}" y2="${py(B.y).toFixed(1)}" ` +
        `stroke="#334155" stroke-width="0.6" stroke-opacity="0.55"/>`,
    );
  });

  for (const n of visible) {
    parts.push(
      `<circle cx="${px(n.x).toFixed(1)}" cy="${py(n.y).toFixed(1)}" ` +
        `r="${Math.max(1.5, n.size * scale * 0.9).toFixed(1)}" fill="${n.color}"/>`,
    );
  }

  const labelled =
    labels === "none"
      ? []
      : labels === "all"
        ? visible
        : visible
            .filter((n) => n.degree >= 6 || ["repository", "organisation"].includes(n.type))
            .slice(0, 220);

  for (const n of labelled) {
    const r = Math.max(1.5, n.size * scale * 0.9);
    parts.push(
      `<text x="${(px(n.x) + r + 3).toFixed(1)}" y="${(py(n.y) + 3).toFixed(1)}" ` +
        `fill="#cbd5e1" font-family="Arial" font-size="${labels === "all" ? 7 : 10}">` +
        `${esc(n.label)}</text>`,
    );
  }

  if (caption) {
    parts.push(
      `<text x="12" y="${size - 12}" fill="#64748b" font-family="Arial" font-size="14">` +
        `${esc(caption)}</text>`,
    );
  }
  parts.push("</svg>");
  return parts.join("\n");
}

export function rasterize(svgPath, pngPath) {
  try {
    execFileSync("magick", ["-font", FONT, svgPath, pngPath]);
    return pngPath;
  } catch {
    return null;
  }
}
