/**
 * No client component may transitively reach a server-only module.
 *
 * This is not a style rule. @earendil-works/pi-coding-agent imports
 * child_process, fs and friends at module scope, so the moment it lands in a
 * browser graph the bundler cannot resolve them and the *entire page* fails to
 * compile. When that happened to the settings page, the visible symptom was a
 * runtime ENOENT for a missing build-manifest.json — which says nothing about
 * the real cause, and nothing failed in tsc, lint, or the test suite.
 *
 * The chain was three hops (a client editor imported a prompts module that
 * imported a config module that imported the agent package), so a one-level
 * check would not have caught it. This walks the whole local import graph.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const SRC = join(process.cwd(), "src");

/** Packages that cannot exist in a browser bundle. */
const SERVER_ONLY = [
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
  "node:child_process",
  "node:fs",
  "node:fs/promises",
  "child_process",
];

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)
      ? [path]
      : [];
  });

/**
 * Runtime import specifiers only. `import type` / `export type` statements are
 * erased by the compiler, so they create no bundling edge — counting them would
 * flag a component that merely borrows a type from a server module.
 */
const importsOf = (source: string): string[] =>
  [
    ...source.matchAll(
      /(?:^|\n)\s*(?:import|export)\s+(type\s+)?([^'"\n]*?)from\s*["']([^"']+)["']/g,
    ),
  ]
    .filter(([, typeKeyword]) => !typeKeyword)
    .map((match) => match[3]);

/** Resolve a local specifier to a file on disk, or null if it is a package. */
const resolveLocal = (specifier: string, fromFile: string): string | null => {
  const base = specifier.startsWith("@/")
    ? join(SRC, specifier.slice(2))
    : specifier.startsWith(".")
      ? resolve(dirname(fromFile), specifier)
      : null;
  if (!base) return null;

  // ".js"/".ts" specifiers both point at the .ts source in this project.
  const stripped = base.replace(/\.(js|ts|tsx)$/, "");
  for (const candidate of [
    `${stripped}.ts`,
    `${stripped}.tsx`,
    join(stripped, "index.ts"),
    join(stripped, "index.tsx"),
  ]) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // keep trying
    }
  }
  return null;
};

const isClientComponent = (source: string): boolean =>
  /^\s*(\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*["']use client["']/.test(source);

/** First server-only import reachable from `entry`, with the chain that leads there. */
function findServerOnlyReach(entry: string): string[] | null {
  const seen = new Set<string>();
  const queue: Array<{ file: string; chain: string[] }> = [
    { file: entry, chain: [entry] },
  ];

  while (queue.length > 0) {
    const { file, chain } = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);

    const source = readFileSync(file, "utf8");
    for (const specifier of importsOf(source)) {
      if (SERVER_ONLY.includes(specifier)) {
        return [...chain, specifier];
      }
      const local = resolveLocal(specifier, file);
      if (local && !seen.has(local)) {
        queue.push({ file: local, chain: [...chain, local] });
      }
    }
  }

  return null;
}

describe("client/server boundary", () => {
  const clientComponents = sourceFiles(SRC).filter((file) =>
    isClientComponent(readFileSync(file, "utf8")),
  );

  it("finds the client components to check", () => {
    // Guards the detection itself: a regex that silently matches nothing would
    // make every assertion below vacuously true.
    expect(clientComponents.length).toBeGreaterThan(5);
  });

  it.each(clientComponents.map((f) => [f.replace(`${process.cwd()}/`, ""), f]))(
    "%s reaches no server-only module",
    (_label, file) => {
      const chain = findServerOnlyReach(file);
      expect(
        chain,
        chain
          ? `Server-only import reachable from a client component:\n  ${chain
              .map((p) => p.replace(`${process.cwd()}/`, ""))
              .join("\n    -> ")}\nThis breaks the whole page's compilation, not just this import.`
          : "",
      ).toBeNull();
    },
  );
});
