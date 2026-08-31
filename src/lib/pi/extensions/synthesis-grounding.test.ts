/**
 * Thresholds pinned against the run that prompted this. Seven sources were
 * synthesized; two pages had drifted from their packets and five had not, and
 * the same threshold separates them with nothing in between.
 */
import { describe, expect, it } from "vitest";

import { coverage, distinctiveWords, groundingReport } from "./synthesis-grounding.ts";

describe("distinctiveWords", () => {
  it("drops words too short to tie a line to a source", () => {
    expect(distinctiveWords("pi js the docker runtime")).toEqual(["docker", "runtime"]);
  });

  it("drops filler that would match any packet", () => {
    expect(distinctiveWords("includes several project files")).toEqual([]);
  });

  it("counts a repeated word once", () => {
    expect(distinctiveWords("docker docker compose")).toEqual(["docker", "compose"]);
  });
});

describe("coverage", () => {
  it("is 1 when every distinctive word appears", () => {
    expect(coverage("vitest config", "vitest.config.mts")).toBe(1);
  });

  it("is 0 when none do", () => {
    expect(coverage("Dockerfile.pi and docker-compose.pi.yml", '{"name":"semla"}')).toBe(0);
  });

  it("treats a line with nothing distinctive as grounded, not as a violation", () => {
    expect(coverage("it is the one", "anything at all")).toBe(1);
  });
});

describe("groundingReport", () => {
  const source = "package.json tsconfig.json next.config.ts vitest.config.mts strict";

  it("reports a claim the source does not carry", () => {
    const report = groundingReport(
      ["Docker containerization for the pi runtime (Dockerfile.pi, docker-compose.pi.yml)"],
      source,
    );

    expect(report.ungrounded).toHaveLength(1);
    expect(report.lowest).toBe(0);
  });

  it("leaves a supported claim alone", () => {
    const report = groundingReport(["Uses vitest with a strict tsconfig"], source);

    expect(report.ungrounded).toEqual([]);
    expect(report.lowest).toBe(1);
  });

  it("orders the worst offender first", () => {
    const report = groundingReport(
      ["Uses vitest and tsconfig strict", "wholly invented claptrap nonsense", "strict tsconfig"],
      source,
    );

    expect(report.ungrounded[0]!.text).toBe("wholly invented claptrap nonsense");
  });

  it("reports a claim about content the given text does not hold", () => {
    const report = groundingReport(["describes directory structure entirely"], "short packet");

    expect(report.ungrounded).toHaveLength(1);
  });

  it("says nothing about a synthesis with no takeaways", () => {
    expect(groundingReport([], source)).toEqual({ ungrounded: [], lowest: 1 });
  });
});
