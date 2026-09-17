/**
 * Reading the captured spec back out of a `capture_feature_spec` tool result.
 *
 * The tool's own result text is the only place the fields survive into the
 * transcript — its structured `details` is not persisted, the same
 * constraint ask-user-record.ts documents for `ask_user`. The format is
 * fixed, one field per call, so this is a straight three-way split rather
 * than the general pairing parseAskUserResult does:
 *
 *     <label>
 *     → <value>
 *
 * blocks joined by a blank line, in the order feature-spec.ts emits them.
 *
 * Structured fields are now also captured directly, at the source, in
 * `SpecArtifact.fields` (src/lib/pi/artifacts/spec-capture.ts) — so a new
 * session's form no longer depends on this re-derivation at all. This parser
 * remains the fallback for a transcript written before that existed, and the
 * transcript (session-steps.ts's `featureSpecItem`) stays the render source
 * for the conversation view either way; the artifact is for the sidebar/UI
 * join, not for replacing this reader.
 */

const ANSWER_PREFIX = "→ ";

export type FeatureSpecField = { label: string; value: string };

/**
 * Fields, in the order they were written. Empty when the text is not in the
 * expected shape at all — a cancellation message, say — which is the
 * caller's cue to fall back to showing the raw text.
 */
export function parseFeatureSpecResult(text: string | undefined): FeatureSpecField[] {
  if (!text?.trim()) return [];

  const fields: FeatureSpecField[] = [];
  let label: string[] = [];
  let value: string[] | null = null;

  const flush = () => {
    if (value === null) return;
    fields.push({ label: label.join("\n").trim(), value: value.join("\n").trim() });
    label = [];
    value = null;
  };

  for (const line of text.split("\n")) {
    if (line.startsWith(ANSWER_PREFIX)) {
      flush();
      value = [line.slice(ANSWER_PREFIX.length)];
      continue;
    }

    if (value === null) {
      label.push(line);
      continue;
    }

    if (line.trim() === "") flush();
    else value.push(line);
  }

  flush();

  return fields.filter((field) => field.label !== "" || field.value !== "");
}
