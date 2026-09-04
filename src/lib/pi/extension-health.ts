/**
 * Extension health, in a shape the UI can render.
 *
 * A broken extension used to be visible only as a line in the server log, which
 * is the wrong place for it: the symptom the user sees is "the agent has no
 * wiki tools", and nothing in the app connected the two. This assembles the
 * static picture (what the manifest declares, whether the entry files are
 * actually installed) with the dynamic one (how the extension set loaded in the
 * most recent session).
 */

import {
  EXTENSION_HEALTH,
  EXTENSION_CONTRACT_VERSION,
  readSlot,
  slotName,
  writeSlot,
} from "@/lib/pi/extension-contract";
import {
  assertExtensionPathsExist,
  assertManifestIsCoherent,
  describeExtensionProblems,
  EXTENSION_MANIFEST,
  extensionEntryId,
  resolveExtensionLoadOrder,
  type ExtensionLoadReport,
} from "@/lib/pi/extension-manifest";
import { getMcpConfigSummary, type McpConfigSummary } from "@/lib/pi/mcp-config";

export type ExtensionHealth = {
  contractVersion: number;
  /** Manifest as declared, in the order extensions are loaded. */
  manifest: Array<{
    id: string;
    path: string;
    requires: string[];
    providesTools: string[];
    optionalTools: string[];
    providesSlots: string[];
  }>;
  /** Static checks that do not need a session. */
  installation: { ok: boolean; problems: string[] };
  /** How the last session actually loaded, if one has run in this process. */
  lastLoad: {
    observedAt: string;
    ok: boolean;
    problems: string[];
    extensions: ExtensionLoadReport["extensions"];
    duplicatePaths: string[];
    unexpectedErrors: string[];
  } | null;
  /**
   * Whether the mcp extension has any server configured, independent of
   * whether any of them connect — a gateway tool with an empty config is the
   * same class of failure as one that never registered, just invisible to
   * the load report because the extension itself loaded fine. Null when the
   * mcp extension is not in the manifest at all.
   */
  mcp: McpConfigSummary | null;
  /** False when anything is known to be wrong right now. */
  ok: boolean;
};

/** Called by session-service after every load so the endpoint has something real to report. */
export function recordExtensionLoad(report: ExtensionLoadReport): void {
  writeSlot(EXTENSION_HEALTH, {
    observedAt: new Date().toISOString(),
    ok: report.ok,
    report,
  });
}

export async function getExtensionHealth(): Promise<ExtensionHealth> {
  const problems: string[] = [];

  for (const check of [assertManifestIsCoherent, assertExtensionPathsExist]) {
    try {
      check();
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
  }

  // Order matters to the reader: it is the thing `requires` exists to control.
  const ordered = (() => {
    try {
      return resolveExtensionLoadOrder();
    } catch {
      return [...EXTENSION_MANIFEST];
    }
  })();

  const snapshot = readSlot(EXTENSION_HEALTH);
  const report = (snapshot?.report ?? null) as ExtensionLoadReport | null;

  const mcp = EXTENSION_MANIFEST.some((spec) => spec.id === "mcp")
    ? await getMcpConfigSummary()
    : null;

  const lastLoad = snapshot && report
    ? {
        observedAt: snapshot.observedAt,
        ok: report.ok,
        problems: describeExtensionProblems(report),
        extensions: report.extensions,
        duplicatePaths: report.duplicatePaths,
        unexpectedErrors: report.unexpectedErrors,
      }
    : null;

  return {
    contractVersion: EXTENSION_CONTRACT_VERSION,
    manifest: ordered.map((spec) => ({
      id: spec.id,
      path: extensionEntryId(spec),
      requires: [...spec.requires],
      providesTools: [...spec.providesTools],
      optionalTools: [...spec.optionalTools],
      providesSlots: spec.providesSlots.map(slotName),
    })),
    installation: { ok: problems.length === 0, problems },
    lastLoad,
    mcp,
    // A session that has not run yet is not a failure — it is just unobserved.
    // An mcp extension with no configured servers is not a failure either — an
    // operator who has not written an mcp.json yet is a valid, if inert, state.
    ok: problems.length === 0 && (lastLoad?.ok ?? true),
  };
}
