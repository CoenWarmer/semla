/**
 * Puts this repository's own language servers on PATH before pi loads packages.
 *
 * @mrclrchtr/supi-code-intelligence finds language servers the way every LSP
 * client does: by binary name on PATH. Semla installs typescript-language-server
 * as a devDependency rather than leaning on a global one, for the same reason
 * the agent directory is isolated to ~/.semla/agent (see agent-dir.ts) — what
 * the agent can see should follow from this repository, not from whatever
 * happens to be installed on the machine that runs it.
 *
 * The failure mode is what makes this worth a module rather than a line. A
 * missing server does not break supi: it reports semantic relations as
 * unavailable and falls back to tree-sitter structural evidence. That is honest,
 * and it is also silent — the only symptom is that answers about how code
 * connects quietly get shallower. So the resolution is computed once at boot and
 * reported, rather than left to be inferred later from a thin result.
 *
 * pi runs in-process, so prepending to `process.env.PATH` here is enough: the
 * language server child processes supi spawns inherit it.
 */

import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

/**
 * Binaries supi looks for, by the language they serve.
 *
 * Only TypeScript is installed today. The rest are listed because supi supports
 * them and a reader should be able to see what adding one costs: a devDependency
 * and a line here, not new extraction code.
 */
export const LANGUAGE_SERVER_BINARIES: Readonly<Record<string, string>> = {
  typescript: "typescript-language-server",
};

export type LanguageServerReport = {
  /** Directory that was prepended, whether or not it was already present. */
  binDir: string;
  /** True when PATH did not already contain binDir and was changed. */
  added: boolean;
  /** Languages whose server binary resolved inside binDir. */
  resolved: string[];
  /** Languages whose server binary is absent, so supi degrades to structural. */
  missing: string[];
};

/** The local bin directory npm links executables into. */
export function localBinDir(cwd: string = process.cwd()): string {
  return join(cwd, "node_modules", ".bin");
}

/**
 * Prepend `binDir` to a PATH value, unless it is already on it.
 *
 * Pure so the ordering rule is testable without mutating the process. Prepending
 * rather than appending is deliberate: a globally installed server of a
 * different version should not win over the one this repository pins.
 */
export function withLocalBin(path: string | undefined, binDir: string): string {
  const entries = (path ?? "").split(delimiter).filter(Boolean);
  if (entries.includes(binDir)) return entries.join(delimiter);
  return [binDir, ...entries].join(delimiter);
}

/** Which of the known servers actually exist in `binDir`. */
export function resolveLanguageServers(
  binDir: string,
  binaries: Readonly<Record<string, string>> = LANGUAGE_SERVER_BINARIES,
): Pick<LanguageServerReport, "missing" | "resolved"> {
  const resolved: string[] = [];
  const missing: string[] = [];

  for (const [language, binary] of Object.entries(binaries)) {
    (existsSync(join(binDir, binary)) ? resolved : missing).push(language);
  }

  return { missing, resolved };
}

/**
 * One human-readable line for the boot log.
 *
 * Missing servers are phrased as the consequence ("degraded to structural
 * evidence") rather than the cause ("binary not found"), because the consequence
 * is what someone reading a thin code answer needs to connect it back to here.
 */
export function describeLanguageServers(report: LanguageServerReport): string {
  const parts: string[] = [];

  parts.push(
    report.resolved.length > 0
      ? `[pi] language servers on PATH: ${report.resolved.join(", ")}`
      : "[pi] no language servers resolved",
  );

  if (report.missing.length > 0) {
    parts.push(
      `${report.missing.join(", ")} unavailable — code intelligence degrades to ` +
        "structural (tree-sitter) evidence for those languages",
    );
  }

  return parts.join("; ");
}

/**
 * Put the local bin directory on PATH and report what that made available.
 *
 * Idempotent: safe to call from a hot-reloaded module without growing PATH.
 */
export function ensureLanguageServersOnPath(
  cwd: string = process.cwd(),
): LanguageServerReport {
  const binDir = localBinDir(cwd);
  const before = process.env.PATH;
  const after = withLocalBin(before, binDir);
  const added = after !== before;

  process.env.PATH = after;

  return { added, binDir, ...resolveLanguageServers(binDir) };
}
