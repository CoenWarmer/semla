/**
 * The `orient_status` tool: report and refresh what can verify a change here.
 *
 * Phase 3 of docs/plans/orient-and-verification-signals.md, and only phase 3 —
 * the code-index and wiki modes described in §7 are not implemented yet, and
 * this tool says so rather than answering for them.
 *
 * **Why a tool and not a script step in the `orient` skill.** Skills in
 * `dynamic-workflows/skills/` are plain markdown injected into the system
 * prompt. The agent following that markdown can call tools or bash; it cannot
 * import a TypeScript module, which is what "run the discovery module and
 * write the status file" needed. A factory extension runs inside the Next
 * server process with the `@/` alias working, so it reaches the discovery and
 * persistence modules directly with no HTTP hop and no auth dance —
 * code-search.ts is the worked example.
 *
 * A `scripts/*.mjs` CLI invoked via bash would also work and matches an
 * existing precedent. It loses the type graph: tsconfig.json covers `src/**`
 * only, and .oxlintrc.json turns the type-aware rules off for `**\/*.mjs`, so
 * `no-floating-promises` and `no-base-to-string` would not run on it.
 *
 * **This does not make orient autonomous.** Who decides to invoke and whether
 * a callable entry point exists are different questions; a tool the skill
 * instructs the agent to call at a numbered step is still skill-invoked.
 */

import { resolve } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  isVerificationStale,
  readVerificationStatus,
  writeVerificationStatus,
  type VerificationStatus,
  type VerificationStatusRead,
} from "@/lib/orient-status/verification-status";
import { discoverVerificationSignals } from "@/lib/verification-signals/discover";
import { renderDiscoveryResult } from "@/lib/verification-signals/render";

const OrientStatusSchema = Type.Object(
  {
    run: Type.Optional(
      Type.Union([Type.Literal("verification-signals")], {
        description:
          'Re-run a phase and record its status. Only "verification-signals" is ' +
          "implemented; omit to report without writing anything.",
      }),
    ),
  },
  { additionalProperties: false },
);

/**
 * One `details` shape for both modes.
 *
 * Pi infers a tool's details type from what `execute` returns, so two
 * structurally different object literals make the second one unassignable to
 * the first's inferred type. Declaring it once also means the turn's event
 * router sees a stable record whichever mode produced it.
 */
interface OrientStatusDetails {
  type: "orient-status";
  warnings: string[];
  /** Set by the run mode: what was just written. */
  status?: VerificationStatus;
  /** Set by the report mode: what was on disk, and whether it still holds. */
  read?: VerificationStatusRead;
  stale?: boolean;
}

/** What `orient_status({})` says about phases that have no implementation yet. */
const UNIMPLEMENTED_PHASES =
  "Code-index refresh and wiki orient are not reachable through this tool yet. " +
  "For the index, use the settings panel or /api/code-index; for the wiki, the " +
  "`orient` skill drives it through the wiki tools.";

export default function orientStatusExtension(pi: ExtensionAPI) {
  // Pi hands the factory process.cwd(), not the session's project — the same
  // constraint code-search.ts and code-map.ts document. Every answer here is
  // about one project (which package.json, which status file), so reporting
  // against the wrong root would be silently wrong rather than empty.
  let cwd = process.cwd();

  pi.on("session_start", (_event: unknown, ctx: ExtensionContext) => {
    cwd = resolve(ctx.cwd || process.cwd());
  });

  pi.registerTool({
    name: "orient_status",
    label: "Orient status",
    description:
      "Report what can verify a change in this project — test, lint, typecheck, " +
      "dev-server and MCP signals — and whether that picture is still current. " +
      "Call it before claiming a change is verified, or when you would otherwise " +
      "guess at whether a test runner exists. Discovery is static: it says what " +
      "exists and could be run, never whether it currently passes.",
    promptGuidelines: [
      'Pass run: "verification-signals" to refresh; omit `run` to read the recorded picture without writing.',
      "Treat configured-not-verified as needing a check of its own — nothing here probed a port or connected to an MCP server.",
      "Report the state you were given rather than re-deriving it; a stale record says so explicitly.",
    ],
    parameters: OrientStatusSchema,
    async execute(_toolCallId: string, params: { run?: "verification-signals" }) {
      if (params.run === "verification-signals") {
        const result = await discoverVerificationSignals({ root: cwd });
        const written = await writeVerificationStatus({
          // ISO from the clock, recorded rather than derived, because a reader
          // needs to know when the picture was taken even when the digest
          // still matches.
          capturedAt: new Date().toISOString(),
          inputsDigest: result.inputsDigest,
          root: cwd,
          signals: result.signals,
        });

        return {
          content: [
            {
              text: renderDiscoveryResult(result, { root: cwd, statusPath: written.path }),
              type: "text",
            },
          ],
          details: {
            status: written.status,
            type: "orient-status",
            warnings: result.warnings,
          } satisfies OrientStatusDetails as OrientStatusDetails,
        };
      }

      // Report mode. The digest is recomputed because that is the only way to
      // know the record is still current, and it costs about six small reads —
      // deliberately unlike phase 1's staleness check, which enumerates and
      // hashes the whole tree and is not affordable on a report.
      const result = await discoverVerificationSignals({ root: cwd });
      const read = await readVerificationStatus(cwd);
      const stale = isVerificationStale(read, result.inputsDigest);

      const lines: string[] = [`Orient status for ${cwd}`, ""];
      switch (read.kind) {
        case "never-run":
          lines.push(
            "Verification signals: never recorded. The signals below were just " +
              'discovered but not saved — pass run: "verification-signals" to record them.',
          );
          break;
        case "unreadable":
          lines.push(
            `Verification signals: recorded file at ${read.path} could not be read ` +
              `(${read.reason}). Re-run to replace it.`,
          );
          break;
        case "orphaned":
          lines.push(
            `Verification signals: the record at ${read.path} describes ` +
              `${read.recordedRoot}, not ${read.expectedRoot}. The status directory is ` +
              "orphaned — re-run to replace it.",
          );
          break;
        case "ok":
          lines.push(
            `Verification signals: recorded ${read.status.capturedAt}, ` +
              `${stale ? "STALE — an input file has changed since" : "current"}.`,
          );
          break;
      }
      lines.push("", UNIMPLEMENTED_PHASES, "");
      lines.push(renderDiscoveryResult(result, { root: cwd }));

      return {
        content: [{ text: lines.join("\n"), type: "text" }],
        details: {
          read,
          stale,
          type: "orient-status",
          warnings: result.warnings,
        } satisfies OrientStatusDetails as OrientStatusDetails,
      };
    },
  });
}
