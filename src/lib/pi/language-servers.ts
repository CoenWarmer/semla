/**
 * Puts this repository's own language servers on PATH before pi loads packages.
 *
 * @mrclrchtr/supi-code-intelligence finds language servers the way every LSP
 * client does: by binary name on PATH. Semla puts its own directories there
 * rather than leaning on a global install, for the same reason the agent
 * directory is isolated to ~/.semla/agent (see agent-dir.ts) — what the agent
 * can see should follow from this repository, not from whatever happens to be
 * installed on the machine that runs it.
 *
 * TypeScript is served by TypeScript 7, which has no tsserver and ships no
 * language-server package: it answers LSP from the compiler binary itself. supi
 * spawns `typescript-language-server --stdio` and its server table is only
 * configurable per-cwd or per-home, neither of which is this repository, so the
 * translation lives in `scripts/language-servers/typescript-language-server` —
 * a shim under our control on a PATH entry under our control. That is why two
 * directories go on PATH: the shim directory, and node_modules/.bin for the
 * `tsc` it execs and for any future server installed as a devDependency.
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
 * Only TypeScript is available today, via the shim described above rather than
 * a package. The rest are listed because supi supports them and a reader should
 * be able to see what adding one costs: a devDependency and a line here, not
 * new extraction code.
 */
export const LANGUAGE_SERVER_BINARIES: Readonly<Record<string, string>> = {
  typescript: "typescript-language-server",
};

export type LanguageServerReport = {
  /** Directories that were prepended, whether or not they were already present. */
  binDirs: readonly string[];
  /** True when PATH did not already contain all of them and was changed. */
  added: boolean;
  /** Languages whose server binary resolved inside one of them. */
  resolved: string[];
  /** Languages whose server binary is absent, so supi degrades to structural. */
  missing: string[];
};

/** The local bin directory npm links executables into. */
export function localBinDir(cwd: string = process.cwd()): string {
  return join(cwd, "node_modules", ".bin");
}

/** Where this repository keeps the server shims it maintains itself. */
export function shimBinDir(cwd: string = process.cwd()): string {
  return join(cwd, "scripts", "language-servers");
}

/**
 * The directories that hold servers, in PATH order.
 *
 * The shim directory comes first so the TypeScript 7 shim outranks any
 * `typescript-language-server` a machine happens to have installed globally —
 * that one would be a TS 5 server with no compiler behind it.
 */
export function languageServerBinDirs(
  cwd: string = process.cwd(),
): readonly string[] {
  return [shimBinDir(cwd), localBinDir(cwd)];
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

/** Which of the known servers actually exist in any of `binDirs`. */
export function resolveLanguageServers(
  binDirs: readonly string[],
  binaries: Readonly<Record<string, string>> = LANGUAGE_SERVER_BINARIES,
): Pick<LanguageServerReport, "missing" | "resolved"> {
  const resolved: string[] = [];
  const missing: string[] = [];

  for (const [language, binary] of Object.entries(binaries)) {
    const found = binDirs.some((dir) => existsSync(join(dir, binary)));
    (found ? resolved : missing).push(language);
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
  const binDirs = languageServerBinDirs(cwd);
  const before = process.env.PATH;

  // Prepended back-to-front, so the first entry of binDirs ends up first
  // on PATH.
  const after = [...binDirs]
    .reverse()
    .reduce<string>((path, dir) => withLocalBin(path, dir), before ?? "");
  const added = after !== before;

  process.env.PATH = after;

  return { added, binDirs, ...resolveLanguageServers(binDirs) };
}
