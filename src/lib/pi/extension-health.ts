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
  resolveExtensionLoadOrder,
  type ExtensionLoadReport,
} from "@/lib/pi/extension-manifest";

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

export function getExtensionHealth(): ExtensionHealth {
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
      path: spec.path,
      requires: [...spec.requires],
      providesTools: [...spec.providesTools],
      optionalTools: [...spec.optionalTools],
      providesSlots: spec.providesSlots.map(slotName),
    })),
    installation: { ok: problems.length === 0, problems },
    lastLoad,
    // A session that has not run yet is not a failure — it is just unobserved.
    ok: problems.length === 0 && (lastLoad?.ok ?? true),
  };
}
