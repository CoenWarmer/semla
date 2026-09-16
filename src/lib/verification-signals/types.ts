/**
 * What "this repo can verify a change" means, as data.
 *
 * Phase 3 of docs/plans/orient-and-verification-signals.md. Discovery answers
 * "what exists and could be run", never "does it pass" — actually invoking a
 * signal stays an ordinary tool call the agent makes later, using these facts.
 */

export type SignalCategory =
  | "unit-test"
  | "integration-test"
  | "e2e-test"
  | "lint"
  | "typecheck"
  | "dev-server"
  | "mcp";

/**
 * - `available` — statically confirmed present and usable: a script exists.
 * - `configured-not-verified` — declared but not confirmed live. A config file
 *   with no script behind it, a dev server nothing has probed, an MCP server
 *   nothing has connected to.
 * - `possible-not-configured` — a dependency is *declared* but nothing wires it
 *   up. Only ever emitted off a real declaration, never inferred intent: "you
 *   could add a linter" is not a finding.
 */
export type SignalState =
  | "available"
  | "configured-not-verified"
  | "possible-not-configured";

export interface VerificationSignal {
  category: SignalCategory;
  state: SignalState;
  /** The fact that decided the state. e.g. `package.json scripts.test = "vitest run"` */
  evidence: string;
  /** MCP server name, config file path, or dependency name. */
  detail?: string;
}

export interface DiscoveryResult {
  signals: VerificationSignal[];
  /**
   * sha256 over the exact input files read, keyed by a machine-independent
   * label and folded in a fixed order. This is phase 3's staleness key: a
   * commit sha cannot see `mcp.json`, which lives outside every project.
   */
  inputsDigest: string;
  /** Digest keys, in the order they were folded. Reported, not persisted. */
  inputs: string[];
  /**
   * Things that silently shrink the signal set — a corrupt `package.json`
   * costs every script-derived signal, and an empty answer with no explanation
   * is the failure mode this harness exists to avoid.
   */
  warnings: string[];
}
