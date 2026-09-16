/**
 * Verification signals suggested by an installed skill's prose.
 *
 * `discover.ts` is static-only by design — it reads manifests and configs,
 * never a model. A skill's `SKILL.md` is different in kind from those inputs:
 * it is free-form instructions for an agent, not structured data, so there is
 * no key to look up the way `scripts.test` is looked up in `package.json`.
 * `next-dev-loop`'s SKILL.md, for instance, documents probing `/_next/mcp`'s
 * `tools/list` against a running dev server — a real, usable verification
 * method, but stated only in prose. Extracting it mechanically (a regex for
 * "http" or "mcp") would be exactly the kind of inference discover.ts refuses
 * to do elsewhere, just relocated into a pattern that will misfire on the next
 * skill's phrasing.
 *
 * So this module asks a model to read each skill's body and say, plainly,
 * whether it describes a concrete check — quoting the sentence rather than
 * paraphrasing, and answering "no" rather than inventing one when it does not.
 * That keeps the judgement visible and falsifiable: the evidence on every
 * emitted signal is the model's quote, not a claim this module makes on its
 * own. Signals from here carry `state: "suggested-by-skill"`, never any of
 * discover.ts's three directly-read states — seeing that state on a signal is
 * itself the disclosure that a model, not a file read, produced it.
 *
 * Model call plumbing (cheap-model selection, the "no text back" failure mode
 * that a misconfigured provider produces with no thrown error) mirrors
 * read-router.ts's callModel/chooseModel — same hazard, same fix, kept
 * independent here because this module has no reason to depend on an
 * extension file.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { SignalCategory, VerificationSignal } from "./types";

export interface SkillSource {
  /** Skill name from its frontmatter. */
  name: string;
  /** Absolute path to the skill's SKILL.md (or root .md file). */
  filePath: string;
  /** Full skill body, frontmatter included — the model reads this verbatim. */
  content: string;
}

const CATEGORIES: SignalCategory[] = [
  "unit-test",
  "integration-test",
  "e2e-test",
  "lint",
  "typecheck",
  "dev-server",
  "mcp",
];

const EXTRACTION_SYSTEM_PROMPT =
  "You read one agent skill file and decide whether it describes a concrete, nameable way to check " +
  "whether a code change worked — a script to run, an HTTP endpoint to call, or a tool to invoke. " +
  "Never invent one. If the skill is general advice, a workflow with no verification step, or " +
  "describes a check only in the abstract (\"test your changes\"), answer that it has none. " +
  "A real finding names a specific thing: an endpoint path, a command, a tool name — not a category " +
  "of activity. " +
  'Reply with strict JSON only, no prose: {"findings":[{"category":"unit-test|integration-test|e2e-test|lint|typecheck|dev-server|mcp","quote":"the exact sentence(s) from the skill that state this","summary":"one short clause describing what to do"}]}. ' +
  'Return {"findings":[]} when nothing qualifies. The "quote" field must be copied verbatim from the input — never paraphrased — so a reader can find it in the source file.';

interface RawFinding {
  category?: unknown;
  quote?: unknown;
  summary?: unknown;
}

interface ExtractionOutcome {
  ok: boolean;
  findings: RawFinding[];
  reason?: string;
}

function isSignalCategory(value: unknown): value is SignalCategory {
  return typeof value === "string" && (CATEGORIES as string[]).includes(value);
}

function parseExtraction(text: string): ExtractionOutcome {
  // Models occasionally wrap JSON in a fenced block despite the instruction
  // not to add prose; strip fences before parsing rather than failing on them.
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "");

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch (error) {
    return {
      findings: [],
      ok: false,
      reason: `model reply was not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as Record<string, unknown>).findings)) {
    return { findings: [], ok: false, reason: "model reply did not have a findings array" };
  }

  return { findings: (parsed as { findings: RawFinding[] }).findings, ok: true };
}

export interface SkillModelCaller {
  (skill: SkillSource): Promise<{ ok: true; text: string } | { ok: false; reason: string }>;
}

export interface SkillSignalsResult {
  signals: VerificationSignal[];
  warnings: string[];
}

/**
 * Turn a set of skills into `suggested-by-skill` signals, one model call per
 * skill. Takes a caller rather than an `ExtensionContext` directly so tests
 * can supply a fixed response without a real model registry.
 */
export async function deriveSkillSignals(
  skills: SkillSource[],
  callModel: SkillModelCaller,
): Promise<SkillSignalsResult> {
  const signals: VerificationSignal[] = [];
  const warnings: string[] = [];

  for (const skill of skills) {
    const outcome = await callModel(skill);
    if (!outcome.ok) {
      warnings.push(`Could not read "${skill.name}" for verification signals: ${outcome.reason}`);
      continue;
    }

    const extraction = parseExtraction(outcome.text);
    if (!extraction.ok) {
      warnings.push(`Could not read "${skill.name}" for verification signals: ${extraction.reason}`);
      continue;
    }

    for (const finding of extraction.findings) {
      if (!isSignalCategory(finding.category)) continue;
      if (typeof finding.quote !== "string" || finding.quote.trim().length === 0) continue;
      const summary = typeof finding.summary === "string" && finding.summary.trim().length > 0
        ? finding.summary.trim()
        : null;

      signals.push({
        category: finding.category,
        detail: skill.name,
        evidence: summary === null
          ? `"${skill.name}" skill: "${finding.quote.trim()}"`
          : `"${skill.name}" skill: ${summary} ("${finding.quote.trim()}")`,
        state: "suggested-by-skill",
      });
    }
  }

  return { signals, warnings };
}

/**
 * A `SkillModelCaller` backed by a real model, mirroring read-router.ts's
 * callModel/chooseModel: same "no configured auth resolves with an empty
 * success, not a thrown error" hazard, same fix — check `stopReason` and
 * treat empty text as failure rather than as "nothing to report".
 */
export function createModelCaller(
  ctx: ExtensionContext,
  provider: string,
  modelId: string,
): SkillModelCaller {
  return async (skill: SkillSource) => {
    const model = ctx.modelRegistry.find(provider, modelId);
    if (!model) {
      return { ok: false, reason: `no model "${provider}/${modelId}" in the catalogue` };
    }

    let response;
    try {
      response = await ctx.modelRegistry.complete(model, {
        messages: [
          {
            content: `Skill "${skill.name}" (${skill.filePath}):\n\n${skill.content}`,
            role: "user" as const,
            timestamp: Date.now(),
          },
        ],
        systemPrompt: EXTRACTION_SYSTEM_PROMPT,
      });
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }

    if (response.stopReason === "error") {
      return { ok: false, reason: response.errorMessage ?? "model returned an error" };
    }

    const text = response.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text" && "text" in c)
      .map((c) => c.text)
      .join("");

    if (!text) return { ok: false, reason: "model returned no text" };
    return { ok: true, text };
  };
}
