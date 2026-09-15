/**
 * feature-spec.ts's result text is the whole contract, the same way
 * ask-user.ts's is for parseAskUserResult — see that file's own test for the
 * reasoning this mirrors.
 */
import { describe, expect, it } from "vitest";

import { parseFeatureSpecResult } from "./feature-spec-record.ts";

describe("parseFeatureSpecResult", () => {
  it("parses the format feature-spec.ts emits", () => {
    const fields = parseFeatureSpecResult(
      "Overarching goal\n→ Let users export reports\n\nFunctional requirements\n→ CSV and PDF export\n\nNon-functional requirements\n→ Export completes in under 5s",
    );

    expect(fields).toEqual([
      { label: "Overarching goal", value: "Let users export reports" },
      { label: "Functional requirements", value: "CSV and PDF export" },
      { label: "Non-functional requirements", value: "Export completes in under 5s" },
    ]);
  });

  it("keeps every line of a multi-line value", () => {
    const fields = parseFeatureSpecResult(
      "Functional requirements\n→ first requirement\nsecond requirement",
    );

    expect(fields).toEqual([
      { label: "Functional requirements", value: "first requirement\nsecond requirement" },
    ]);
  });

  it("records the placeholder the tool writes for an empty field", () => {
    const fields = parseFeatureSpecResult("Overarching goal\n→ (none given)");

    expect(fields).toEqual([{ label: "Overarching goal", value: "(none given)" }]);
  });

  it("returns nothing for text that is not in the expected shape", () => {
    expect(parseFeatureSpecResult("capture_feature_spec was cancelled: aborted")).toEqual([]);
    expect(parseFeatureSpecResult(undefined)).toEqual([]);
    expect(parseFeatureSpecResult("   ")).toEqual([]);
  });
});
