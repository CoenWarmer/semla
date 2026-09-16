/**
 * Verification-signal discovery: what could verify a change in this repo.
 *
 * Phase 3 of docs/plans/orient-and-verification-signals.md. Static only — it
 * reads manifests and tool configs and never runs a command, never opens a
 * port, and never connects to an MCP server. §4.4 defers liveness deliberately:
 * a dev-server probe and an MCP connection cost a real round trip, and the
 * latter is only answerable from inside a session that has the `mcp` tool
 * bound, which a module cannot assume it is.
 *
 * Every file the discovery consults is also folded into `inputsDigest`,
 * including the ones that turned out to be absent — see digest.ts for why a
 * skipped input would make a deleted config invisible.
 */

import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import { getMcpConfigSummary } from "@/lib/pi/runtime/mcp-config";

import { computeInputsDigest, type DigestInput } from "./digest";
import type { DiscoveryResult, VerificationSignal } from "./types";

/**
 * Config files that mark a category as configured, per family. The list is
 * fixed rather than globbed so the digest covers a stable, enumerable set of
 * inputs: a glob would fold a different number of absent markers depending on
 * what happened to be on disk, and the digest would move for reasons nothing
 * could explain.
 */
const CONFIG_CANDIDATES = {
  "unit-test": [
    "vitest.config.ts",
    "vitest.config.mts",
    "vitest.config.js",
    "vitest.config.mjs",
    "jest.config.ts",
    "jest.config.js",
    "jest.config.mjs",
    "jest.config.json",
  ],
  "e2e-test": [
    "playwright.config.ts",
    "playwright.config.mts",
    "playwright.config.js",
    "cypress.config.ts",
    "cypress.config.js",
    "cypress.config.mjs",
  ],
  lint: [".oxlintrc.json", "eslint.config.ts", "eslint.config.js", "eslint.config.mjs"],
  typecheck: ["tsconfig.json"],
  "dev-server": ["next.config.ts", "next.config.mjs", "next.config.js", "vite.config.ts"],
} as const;

/**
 * Script names per category, in precedence order. `tsc` precedes `typecheck`
 * because this repository's script is `tsc` and has no `typecheck` — the
 * plan's first draft checked only the name this repo does not have, and would
 * have reported typecheck absent on the one repo §9 verifies against.
 */
const SCRIPT_CANDIDATES = {
  "unit-test": ["test", "test:unit"],
  // Kept as a distinct category but emitted only off a distinct script.
  // Nothing statically separates unit from integration in a package.json that
  // has only `test`, so with no dedicated script there is no signal rather
  // than a duplicate of unit-test under a second name.
  "integration-test": ["test:integration"],
  "e2e-test": ["test:e2e"],
  lint: ["lint"],
  typecheck: ["tsc", "typecheck"],
  "dev-server": ["dev"],
} as const;

/** Dependencies whose mere presence makes an e2e suite *possible*. */
const E2E_DEPENDENCIES = [
  "@playwright/test",
  "playwright",
  "cypress",
] as const;

interface PackageManifest {
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
}

const EMPTY_MANIFEST: PackageManifest = { dependencies: {}, scripts: {} };

/** File contents, or null when it does not exist. Absence is not an error. */
async function readIfPresent(path: string): Promise<string | null> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return null;
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

function parseManifest(
  raw: string | null,
  warnings: string[],
): PackageManifest {
  if (raw === null) {
    warnings.push(
      "No package.json at the project root, so no script-derived signals were found.",
    );
    return EMPTY_MANIFEST;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    // Reported, not thrown: this costs every script-derived signal, and an
    // empty answer with no stated reason is worse than a stated failure.
    warnings.push(
      `package.json could not be parsed (${error instanceof Error ? error.message : String(error)}), ` +
        "so no script-derived signals were found.",
    );
    return EMPTY_MANIFEST;
  }
  if (typeof parsed !== "object" || parsed === null) {
    warnings.push("package.json is not a JSON object, so no script-derived signals were found.");
    return EMPTY_MANIFEST;
  }

  const record = parsed as Record<string, unknown>;
  return {
    dependencies: {
      ...stringRecord(record.dependencies),
      ...stringRecord(record.devDependencies),
    },
    scripts: stringRecord(record.scripts),
  };
}

function stringRecord(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null) return {};
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string") out[key] = entry;
  }
  return out;
}

/** First script name present, with the fact that decided it. */
function findScript(
  manifest: PackageManifest,
  names: readonly string[],
): { evidence: string; name: string } | null {
  for (const name of names) {
    const command = manifest.scripts[name];
    if (typeof command === "string" && command.length > 0) {
      return { evidence: `package.json scripts.${name} = ${JSON.stringify(command)}`, name };
    }
  }
  return null;
}

export interface DiscoverOptions {
  root: string;
}

export async function discoverVerificationSignals(
  options: DiscoverOptions,
): Promise<DiscoveryResult> {
  const root = resolve(options.root);
  const warnings: string[] = [];
  const inputs: DigestInput[] = [];

  const packageRaw = await readIfPresent(join(root, "package.json"));
  inputs.push({ content: packageRaw, label: "package.json" });
  const manifest = parseManifest(packageRaw, warnings);

  // Every candidate is stat'ed so the digest covers absence too; contents are
  // only read for the ones that exist.
  const configsFound = new Map<string, string[]>();
  for (const [category, candidates] of Object.entries(CONFIG_CANDIDATES)) {
    const found: string[] = [];
    for (const candidate of candidates) {
      const content = await readIfPresent(join(root, candidate));
      inputs.push({ content, label: candidate });
      if (content !== null) found.push(candidate);
    }
    configsFound.set(category, found);
  }

  const signals: VerificationSignal[] = [];

  for (const category of [
    "unit-test",
    "integration-test",
    "e2e-test",
    "lint",
    "typecheck",
    "dev-server",
  ] as const) {
    const script = findScript(manifest, SCRIPT_CANDIDATES[category]);
    const configs = configsFound.get(category) ?? [];
    const detail = configs[0];

    if (script !== null) {
      signals.push({
        category,
        // A dev server is never `available`, however plainly its script
        // exists: "available" claims usable-as-verification, and nothing here
        // has checked whether a server is actually up. §4.4.
        state: category === "dev-server" ? "configured-not-verified" : "available",
        evidence: script.evidence,
        ...(detail === undefined ? {} : { detail }),
      });
      continue;
    }

    if (configs.length > 0) {
      // A config with no script behind it is declared but has no confirmed way
      // to run — §4.1's middle state exactly.
      signals.push({
        category,
        state: "configured-not-verified",
        evidence: `${detail} exists, but no ${SCRIPT_CANDIDATES[category].join(" / ")} script runs it`,
        ...(detail === undefined ? {} : { detail }),
      });
      continue;
    }

    if (category === "e2e-test") {
      // The one place a dependency alone is enough — and only because
      // something in the tree already paid for the tool. Never inferred.
      const dependency = E2E_DEPENDENCIES.find(
        (name) => manifest.dependencies[name] !== undefined,
      );
      if (dependency !== undefined) {
        signals.push({
          category,
          state: "possible-not-configured",
          detail: dependency,
          evidence:
            `package.json declares ${dependency}@${manifest.dependencies[dependency]}, ` +
            "but no config file and no test:e2e script wire it up",
        });
      }
    }
    // Otherwise: no signal at all. An absent category is not a finding —
    // "you could add a linter" is advice, not discovery.
  }

  const mcpSummary = await getMcpConfigSummary();
  inputs.push({
    content: await readIfPresent(mcpSummary.configPath),
    // Labelled, not pathed: the absolute path contains a home directory, and
    // the digest must not move because the same config lives under a
    // different user.
    label: "mcp.json",
  });
  if (mcpSummary.error !== null) {
    warnings.push(`MCP config could not be read: ${mcpSummary.error}`);
  }
  if (mcpSummary.hint !== null) {
    warnings.push(mcpSummary.hint);
  }
  for (const server of mcpSummary.enabledServers) {
    signals.push({
      category: "mcp",
      // Never `available`: the config declares a command, and nothing here
      // has connected to it. Connection status only exists inside a live
      // session — see getMcpConfigSummary's docblock.
      state: "configured-not-verified",
      detail: server,
      evidence: `${mcpSummary.configPath} declares mcpServers.${server}, connection not probed`,
    });
  }

  const { digest, labels } = computeInputsDigest(inputs);
  return { inputs: labels, inputsDigest: digest, signals, warnings };
}
