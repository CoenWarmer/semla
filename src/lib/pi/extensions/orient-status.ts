/**
 * The `orient_status` tool: report and refresh what orienting on this repo knows.
 *
 * All three phases of docs/plans/orient-and-verification-signals.md are
 * reachable here now, but they are reachable in three different shapes, and the
 * differences are the design rather than an inconsistency:
 *
 * - **Phase 1, code index.** `run: "code-index"` calls `startIndexRun`, which
 *   registers a run and returns. Nothing is awaited: an ingest is seconds to
 *   minutes of embedding round-trips, and `index-runs.ts` deliberately does not
 *   hand out the promise so that no caller can await it. So this mode reports
 *   that a run *started*, never its result. Polling here instead would make
 *   orient's total runtime the index's runtime — minutes on a large repo — for
 *   a fact the settings panel and the next `code_search` already report.
 * - **Phase 2, wiki.** `record: "wiki"` writes `wiki.json`, and that is all it
 *   does. The wiki pipeline is driven by the wiki's own tools across several of
 *   the `orient` skill's steps, so the skill tells this tool when it finished;
 *   the tool does not run the pipeline. Driving ingest from here would
 *   re-implement the half of orient that already works.
 * - **Phase 3, verification signals.** `run: "verification-signals"` is the one
 *   phase that both computes and records, because the discovery module is its
 *   only implementation.
 *
 * Phase 1 gets no status file of its own, deliberately: `head.json` already
 * carries `updated`, `chunks`, `model` and `merkleRoot`, and a second
 * `capturedAt` would create two answers to "when was this last indexed" that
 * can disagree. See index-status.ts.
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

import { NoEmbeddingCredentialError, startIndexRun } from "@/lib/code-index/index-runs";
import { readGitFacts } from "@/lib/orient-status/git-facts";
import { renderOrientStatus } from "@/lib/orient-status/render";
import {
  collectOrientStaleness,
  type OrientStalenessReport,
} from "@/lib/orient-status/staleness";
import {
  writeVerificationStatus,
  type VerificationStatus,
} from "@/lib/orient-status/verification-status";
import { writeWikiStatus, type WikiStatus } from "@/lib/orient-status/wiki-status";
import { discoverVerificationSignals } from "@/lib/verification-signals/discover";
import { renderDiscoveryResult } from "@/lib/verification-signals/render";

const OrientStatusSchema = Type.Object(
  {
    run: Type.Optional(
      Type.Union(
        [Type.Literal("verification-signals"), Type.Literal("code-index")],
        {
          description:
            'Re-run a phase and record its status. "verification-signals" discovers and ' +
            'records them; "code-index" starts a background index run and returns ' +
            "immediately. Omit to report every phase without writing anything.",
        },
      ),
    ),
    record: Type.Optional(
      Type.Union([Type.Literal("wiki")], {
        description:
          "Record that a phase driven by other tools has completed. \"wiki\" writes " +
          "wiki.json with the current commit sha and dirty flag — call it after the " +
          "`orient` skill's ingest and analysis steps finish, not before.",
      }),
    ),
  },
  { additionalProperties: false },
);

/**
 * One `details` shape for every mode.
 *
 * Pi infers a tool's details type from what `execute` returns, so structurally
 * different object literals make the later ones unassignable to the first's
 * inferred type. Declaring it once also means the turn's event router sees a
 * stable record whichever mode produced it.
 */
interface OrientStatusDetails {
  type: "orient-status";
  warnings: string[];
  /** Set by run: "verification-signals". */
  verification?: VerificationStatus;
  /** Set by record: "wiki". */
  wiki?: WikiStatus;
  /** Set by run: "code-index". */
  indexRun?: { started: boolean; running: boolean; error: string | null };
  /** Set by the report mode. */
  report?: OrientStalenessReport;
}

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
      "Report how well this project is oriented — code index, wiki, and what can " +
      "verify a change here (test, lint, typecheck, dev-server, MCP) — and whether " +
      "each is still current. Call it before claiming a change is verified, or when " +
      "you would otherwise guess at whether a test runner exists. Signal discovery " +
      "is static: it says what exists and could be run, never whether it passes.",
    promptGuidelines: [
      'Pass run: "verification-signals" to refresh signals, run: "code-index" to start an index run, record: "wiki" after the orient skill finishes its wiki steps. Omit both to report without writing.',
      'run: "code-index" returns as soon as the run is registered — it reports that indexing started, never that it finished.',
      "Treat configured-not-verified as needing a check of its own — nothing here probed a port or connected to an MCP server.",
      "Report the state you were given rather than re-deriving it; a stale record says so explicitly.",
    ],
    parameters: OrientStatusSchema,
    async execute(
      _toolCallId: string,
      params: { run?: "verification-signals" | "code-index"; record?: "wiki" },
    ) {
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
            type: "orient-status",
            verification: written.status,
            warnings: result.warnings,
          } satisfies OrientStatusDetails as OrientStatusDetails,
        };
      }

      if (params.run === "code-index") {
        return startIndex(cwd);
      }

      if (params.record === "wiki") {
        const facts = await readGitFacts(cwd);
        const written = await writeWikiStatus({
          capturedAt: new Date().toISOString(),
          commitSha: facts.commitSha,
          dirty: facts.dirty,
          root: cwd,
        });

        const warnings: string[] = [];
        if (facts.commitSha === null) {
          // Said out loud: a record with no sha can never be confirmed fresh,
          // so every later report will call phase 2 stale. That is correct,
          // and it is better to know why now.
          warnings.push(
            `No readable HEAD at ${cwd}, so the wiki record carries no commit sha and ` +
              "freshness can never be confirmed against it.",
          );
        }
        if (facts.dirty === true) {
          warnings.push(
            "The working tree had uncommitted changes, which is recorded. A capture " +
              "taken against a dirty tree describes a state no commit identifies, so it " +
              "reads as stale until the wiki is re-oriented against a clean tree.",
          );
        }

        const lines = [
          `Recorded wiki orient for ${cwd}.`,
          `  captured at: ${written.status.capturedAt}`,
          `  commit: ${written.status.commitSha ?? "none readable"}`,
          `  tree: ${written.status.dirty === null ? "unknown" : written.status.dirty ? "dirty" : "clean"}`,
          `  written to: ${written.path}`,
        ];
        if (warnings.length > 0) {
          lines.push("", "Warnings:");
          for (const warning of warnings) lines.push(`  - ${warning}`);
        }

        return {
          content: [{ text: lines.join("\n"), type: "text" }],
          details: {
            type: "orient-status",
            warnings,
            wiki: written.status,
          } satisfies OrientStatusDetails as OrientStatusDetails,
        };
      }

      // Report mode. Phase 3's digest is recomputed because that is the only
      // way to know its record is still current, and it costs about 25 small
      // reads — deliberately unlike phase 1's check, which enumerates and
      // hashes the whole tree and is not affordable on a report.
      const report = await collectOrientStaleness({ root: cwd });
      const signals = await discoverVerificationSignals({ root: cwd });

      const text = [
        renderOrientStatus(report),
        "",
        renderDiscoveryResult(signals, { root: cwd }),
      ].join("\n");

      return {
        content: [{ text, type: "text" }],
        details: {
          report,
          type: "orient-status",
          warnings: signals.warnings,
        } satisfies OrientStatusDetails as OrientStatusDetails,
      };
    },
  });
}

/**
 * Start an index run and report that it started.
 *
 * `startIndexRun` returns the run as soon as it is registered and never hands
 * out the promise the work runs on, so there is nothing here to await even if
 * awaiting were wanted. The one failure it reports synchronously is a missing
 * embedding credential, which is worth surfacing as such rather than as a run
 * that appears to have started and then silently did nothing.
 */
function startIndex(root: string) {
  const run = startIndexRun(root);
  const alreadyFinished = run.finishedAt !== null;
  const warnings: string[] = [];

  const lines: string[] = [];
  if (run.error !== null) {
    lines.push(`Code index run for ${root} could not start: ${run.error}`);
    if (run.error === new NoEmbeddingCredentialError().message) {
      warnings.push(
        "No embedding credential, so `code_search` cannot be made useful for this " +
          "project until one is configured. The other two orient phases are unaffected.",
      );
    }
  } else if (alreadyFinished) {
    lines.push(`Code index run for ${root} has already finished.`);
  } else {
    lines.push(
      `Code index run started for ${root}. It is running in the background — this ` +
        "tool reports that it started, not that it finished.",
      "",
      "Nothing is awaited here: an ingest is seconds to minutes of embedding " +
        "round-trips, so index-runs.ts does not expose the promise. Check progress " +
        "in the settings panel, or just use `code_search` — it reports its own " +
        "freshness at query time.",
    );
  }

  return {
    // `as const` on the literal: extracted into a helper, the object's `type`
    // widens to `string` and stops satisfying Pi's TextContent.
    content: [{ text: lines.join("\n"), type: "text" as const }],
    details: {
      indexRun: {
        error: run.error,
        running: run.finishedAt === null,
        started: run.error === null,
      },
      type: "orient-status",
      warnings,
    } satisfies OrientStatusDetails as OrientStatusDetails,
  };
}
