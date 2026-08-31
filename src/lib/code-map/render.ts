/**
 * Renders a code map as text for the model.
 *
 * The panel gets the structured map; this is what the agent reads back in order
 * to explain the code in prose. Two things it must carry, or the explanation
 * built on it will be quietly wrong:
 *
 *  - **Where each call is.** Every line cites `file:line` for the callee and the
 *    line of the call itself, so the agent quotes locations it was given rather
 *    than ones it remembers.
 *  - **What is missing.** Truncation and unresolved calls are stated, not
 *    omitted. An agent handed a silently partial map will describe it as if it
 *    were the whole picture, which is the failure this feature exists to
 *    prevent.
 */

import type { CodeMap, CodeMapNode } from "./types.ts";

const plural = (count: number, noun: string) =>
  `${count} ${noun}${count === 1 ? "" : "s"}`;

/** Why the map stops where it does, in a phrase the agent can repeat. */
export function describeBoundary(map: CodeMap): string | null {
  if (!map.truncated) return null;
  return (
    `This map is bounded: it stops at depth ${map.depth} or at the node limit, ` +
    "so callees beyond that edge exist but are not shown. Say so if it matters; " +
    "do not describe this as the complete call graph."
  );
}

export function renderCodeMapText(map: CodeMap): string {
  const byId = new Map(map.nodes.map((node) => [node.id, node]));
  const root = byId.get(map.root);
  const label = (node: CodeMapNode) =>
    node.container ? `${node.container}.${node.name}` : node.name;

  const lines: string[] = [
    `# Code map of \`${root ? label(root) : map.root}\``,
    "",
    root ? `_Entry: \`${root.file}:${root.line}\`_` : "",
    "",
    `${plural(map.nodes.length, "function")}, ${plural(map.edges.length, "call")}, depth ${map.depth}.`,
    "",
  ];

  const boundary = describeBoundary(map);
  if (boundary) lines.push(`**Bounded:** ${boundary}`, "");

  if (map.edges.length > 0) {
    lines.push("## Calls", "");
    // Grouped by caller so the text reads as an outline rather than a list of
    // unrelated pairs.
    const callers = [...new Set(map.edges.map((edge) => edge.from))];
    for (const callerId of callers) {
      const caller = byId.get(callerId);
      if (!caller) continue;
      lines.push(`### ${label(caller)} — \`${caller.file}:${caller.line}\``);
      for (const edge of map.edges.filter((candidate) => candidate.from === callerId)) {
        const callee = byId.get(edge.to);
        if (!callee) continue;
        const where = callee.external ? "external" : `${callee.file}:${callee.line}`;
        const verb = edge.kind === "new" ? "constructs" : "calls";
        lines.push(
          `- ${verb} \`${label(callee)}\` (${where}) at L${edge.sites.join(", L")}`,
        );
      }
      lines.push("");
    }
  }

  if (map.unresolved.length > 0) {
    lines.push(
      `## Not resolved (${map.unresolved.length})`,
      "",
      "_Calls the type checker could not trace to an implementation. They are " +
        "real calls; their targets are not determined here._",
      "",
    );
    for (const item of map.unresolved.slice(0, 20)) {
      lines.push(`- \`${item.name}\` at L${item.line} — ${item.reason}`);
    }
    if (map.unresolved.length > 20) {
      lines.push(`- _…and ${map.unresolved.length - 20} more_`);
    }
    lines.push("");
  }

  return lines.filter((line, index) => !(line === "" && lines[index - 1] === "")).join("\n");
}
