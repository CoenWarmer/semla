/**
 * One staleness comparison, shared by the `orient_status` tool and the per-turn
 * prompt nudge.
 *
 * Two callers asking the same question two ways is how a report and a nudge
 * come to disagree about whether a phase is stale, so there is one function and
 * both render from it.
 *
 * **Each phase has its own key, because each consumes different inputs.**
 *
 * | Phase | Stale when | Cost here |
 * |---|---|---|
 * | code-index | `treeRoot(fingerprints) !== head.merkleRoot` | not computed — see index-status.ts |
 * | wiki | HEAD moved, or the capture was taken dirty | one `rev-parse`, one `status --porcelain` |
 * | verification | the inputs digest moved | ~25 small reads |
 *
 * A single key for all three was the plan's first draft, using
 * `git rev-parse HEAD`. For a harness whose job is editing files that is the
 * wrong key twice over: the dominant state is *uncommitted* work, so the sha is
 * constant across exactly the window in which the index goes stale, and it
 * cannot see `~/.semla/agent/mcp.json` at all, which is per-machine and outside
 * every project — the one drift phase 3 exists to catch.
 *
 * **Nothing here throws.** It is called while assembling a prompt, on the hot
 * path before the model sees anything. A staleness check that can fail a turn
 * is worse than no staleness check, so every phase collapses to an
 * `unknown`-shaped answer and the reason travels with it.
 */

import { discoverVerificationSignals } from "@/lib/verification-signals/discover";

import { readGitFacts } from "./git-facts";
import { readIndexPhaseStatus, type IndexPhaseStatus } from "./index-status";
import {
  isVerificationStale,
  readVerificationStatus,
  type VerificationStatusRead,
} from "./verification-status";
import { isWikiStale, readWikiStatus, type WikiStaleness, type WikiStatusRead } from "./wiki-status";

export interface OrientStalenessReport {
  root: string;
  index: {
    status: IndexPhaseStatus | null;
    /**
     * Never `false`: confirming freshness needs the full tree hash, which is
     * not affordable here. "Indexed, root not recompared" is the strongest
     * claim this report can make.
     */
    stale: "unknown" | "never-indexed";
    /** Set when head.json could not be read at all. */
    error: string | null;
  };
  wiki: {
    read: WikiStatusRead | null;
    staleness: WikiStaleness;
    currentCommitSha: string | null;
    currentDirty: boolean | null;
    error: string | null;
  };
  verification: {
    read: VerificationStatusRead | null;
    stale: boolean;
    /** The digest just computed from the tree, for the caller to record. */
    currentDigest: string | null;
    error: string | null;
  };
}

export interface CollectStalenessOptions {
  root: string;
  /**
   * Skip the ~25 reads phase 3's digest costs. The prompt nudge sets this only
   * when it already knows phase 3 has never run, because there is nothing to
   * compare against and the answer is stale either way.
   */
  skipVerificationDigest?: boolean;
}

export async function collectOrientStaleness(
  options: CollectStalenessOptions,
): Promise<OrientStalenessReport> {
  const { root } = options;

  const [index, wiki, verification] = await Promise.all([
    collectIndex(root),
    collectWiki(root),
    collectVerification(root, options.skipVerificationDigest === true),
  ]);

  return { index, root, verification, wiki };
}

async function collectIndex(root: string): Promise<OrientStalenessReport["index"]> {
  try {
    const status = await readIndexPhaseStatus(root);
    return {
      error: null,
      stale: status.indexed ? "unknown" : "never-indexed",
      status,
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      stale: "unknown",
      status: null,
    };
  }
}

async function collectWiki(root: string): Promise<OrientStalenessReport["wiki"]> {
  try {
    const [read, facts] = await Promise.all([readWikiStatus(root), readGitFacts(root)]);
    return {
      currentCommitSha: facts.commitSha,
      currentDirty: facts.dirty,
      error: null,
      read,
      staleness: isWikiStale(read, { commitSha: facts.commitSha }),
    };
  } catch (error) {
    return {
      currentCommitSha: null,
      currentDirty: null,
      error: error instanceof Error ? error.message : String(error),
      read: null,
      // An unreadable check is not a fresh wiki. Reported as stale with the
      // reason attached, so the caller can say why rather than just nagging.
      staleness: { reason: "unreadable", stale: true },
    };
  }
}

async function collectVerification(
  root: string,
  skipDigest: boolean,
): Promise<OrientStalenessReport["verification"]> {
  try {
    const read = await readVerificationStatus(root);
    if (skipDigest || read.kind !== "ok") {
      // Nothing trustworthy on disk, so no digest can change the answer.
      return { currentDigest: null, error: null, read, stale: true };
    }
    const result = await discoverVerificationSignals({ root });
    return {
      currentDigest: result.inputsDigest,
      error: null,
      read,
      stale: isVerificationStale(read, result.inputsDigest),
    };
  } catch (error) {
    return {
      currentDigest: null,
      error: error instanceof Error ? error.message : String(error),
      read: null,
      stale: true,
    };
  }
}

/** Phases a reader should be told about, as one short sentence each. */
export function describeStalePhases(report: OrientStalenessReport): string[] {
  const lines: string[] = [];

  if (report.index.stale === "never-indexed") {
    lines.push(
      "Code index: never indexed for this project. `code_search` cannot answer until it is.",
    );
  } else if (report.index.error !== null) {
    lines.push(`Code index: status could not be read (${report.index.error}).`);
  }

  const wikiReason = report.wiki.staleness.reason;
  if (wikiReason !== null) {
    lines.push(`Wiki orient: ${WIKI_REASON_TEXT[wikiReason]}`);
  }

  if (report.verification.stale) {
    const read = report.verification.read;
    if (read === null || read.kind === "never-run") {
      lines.push(
        'Verification signals: never recorded. Run `orient_status({ run: "verification-signals" })`.',
      );
    } else if (read.kind === "orphaned") {
      lines.push(
        "Verification signals: the record on disk describes a different project root — re-run to replace it.",
      );
    } else if (read.kind === "unreadable") {
      lines.push("Verification signals: the record on disk could not be read — re-run to replace it.");
    } else {
      lines.push(
        "Verification signals: an input file (package.json, a tool config, or mcp.json) has changed since they were recorded.",
      );
    }
  }

  return lines;
}

const WIKI_REASON_TEXT: Record<NonNullable<WikiStaleness["reason"]>, string> = {
  "captured-dirty":
    "last captured against a tree with uncommitted changes, so no commit identifies what it describes.",
  "commit-moved": "HEAD has moved since the wiki was last oriented for this project.",
  "never-run": "never recorded. Invoke the `orient` skill to initialise the wiki for this repo.",
  "no-commit-sha":
    "recorded without a commit sha, or this project has no readable HEAD, so freshness cannot be confirmed.",
  orphaned: "the record on disk describes a different project root — re-orient to replace it.",
  unreadable: "the record on disk could not be read — re-orient to replace it.",
};
