/**
 * Which model to use for a cheap, non-frontier LLM call — a summary, a
 * classification, an extraction — given the session's own configuration.
 *
 * Shared by read-router.ts and verification-signals/skill-signals.ts, which
 * both need "some inexpensive model reachable from whatever this host has
 * configured" and previously duplicated the same picking logic. Extracted
 * rather than left in read-router.ts because a second caller copying it
 * verbatim was the sign the logic belonged to neither extension specifically.
 *
 * An explicit override is obeyed as given — a configured value is a decision,
 * and silently substituting something else would be worse than failing.
 * Otherwise the session's own provider wins over a hardcoded default: whatever
 * model is driving the session is by definition configured, so a Haiku on
 * that provider is reachable where a hardcoded `anthropic/...` may not be.
 *
 * Only the provider is borrowed from the session, never its model id — that
 * is the frontier model, and running a cheap classification with it would
 * cost more than the call is worth.
 *
 * Two exclusions were found by running this against a live catalogue, not
 * reasoned out, and are worth keeping: a reasoning model is rejected because
 * pi sends `reasoning.effort: "none"` for a plain completion and OpenAI's
 * o-series answers 400 `unsupported_value`; and the name test is anchored,
 * because an unanchored `/mini/` matched `minimax/minimax-m1`, a different
 * vendor's frontier model — the opposite of choosing something cheap.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const DEFAULT_CHEAP_MODEL = "anthropic/claude-haiku-4-5-20251001";

export function parseModelSpec(modelSpec: string): { provider: string; modelId: string } {
  const slash = modelSpec.indexOf("/");
  if (slash === -1) return { provider: modelSpec, modelId: modelSpec };
  return { provider: modelSpec.slice(0, slash), modelId: modelSpec.slice(slash + 1) };
}

export function chooseCheapModel(
  ctx: ExtensionContext,
  override?: string,
): { provider: string; modelId: string } {
  if (override) return parseModelSpec(override);

  const fallback = parseModelSpec(DEFAULT_CHEAP_MODEL);
  const sessionProvider = ctx.model?.provider;
  if (!sessionProvider || sessionProvider === fallback.provider) return fallback;

  // A same-provider Haiku, addressed as that provider spells it. Gateways
  // prefix the vendor (openrouter: "anthropic/claude-haiku-4.5"), so the id is
  // matched rather than constructed.
  const candidate = ctx.modelRegistry
    .getAll()
    .filter((model) => model.provider === sessionProvider)
    // `-mini`/`-flash` as a suffix or path segment, never as a substring of a
    // vendor's name. Haiku is matched loosely because Anthropic only uses it
    // for the cheap tier.
    .filter((model) => /haiku|[-/](?:flash|mini)\b/i.test(model.id))
    // A batch endpoint does not answer synchronously; `~` marks an alias.
    .filter((model) => !/batch|^~/.test(model.id))
    // Reasoning models reject the `reasoning.effort: "none"` pi sends here.
    .filter((model) => !model.reasoning)
    .sort((a, b) => a.id.length - b.id.length)[0];

  return candidate
    ? { modelId: candidate.id, provider: sessionProvider }
    : fallback;
}
