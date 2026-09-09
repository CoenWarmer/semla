/**
 * Which files of a project get indexed, and an account of the ones that do not.
 *
 * Built on `walkFiles` rather than a second walk, so the ignored-directory set
 * and the entry budget stay in one place. The budget matters here for the same
 * reason it does there: pointed at a workspace root by mistake, an unbounded
 * walk is a request that never returns.
 *
 * Everything excluded is returned, not dropped. A retrieval tool that has
 * quietly not read a third of the tree is worse than one that says so — the
 * model cannot otherwise tell "no match" from "never looked", and will report
 * the absence of a thing it was never shown.
 */

import { stat } from "node:fs/promises";
import { relative, sep } from "node:path";

import { walkFiles } from "@/lib/pi/file-walk";

import { languageOf, type IndexLanguage } from "./languages";
import type { SkipReport } from "./types";

/**
 * Files past this are excluded. Generated bundles, lockfiles and checked-in
 * data dominate above it, and one such file can outweigh the hand-written
 * source it would be ranked against.
 */
export const MAX_FILE_BYTES = 512 * 1024;

/** Entry budget for the walk. Comfortably above a large repository's file count. */
export const DEFAULT_WALK_BUDGET = 200_000;

export interface EnumeratedFile {
  /** Project-relative POSIX path. */
  path: string;
  language: IndexLanguage;
  bytes: number;
}

export interface EnumerateResult {
  files: EnumeratedFile[];
  skipped: SkipReport;
}

export async function enumerateProject(
  root: string,
  { budget = DEFAULT_WALK_BUDGET }: { budget?: number } = {},
): Promise<EnumerateResult> {
  const absolutePaths: string[] = [];
  const walk = await walkFiles(root, (absolutePath) => {
    absolutePaths.push(absolutePath);
  }, { budget });

  const files: EnumeratedFile[] = [];
  const skipped: SkipReport = {
    tooLarge: [],
    unsupported: [],
    unreadable: [],
    complete: walk.complete,
  };

  for (const absolutePath of absolutePaths) {
    const path = toPosix(relative(root, absolutePath));
    const language = languageOf(path);
    if (language === null) {
      skipped.unsupported.push(path);
      continue;
    }

    let bytes: number;
    try {
      bytes = (await stat(absolutePath)).size;
    } catch {
      skipped.unreadable.push(path);
      continue;
    }

    if (bytes > MAX_FILE_BYTES) {
      skipped.tooLarge.push(path);
      continue;
    }
    if (bytes === 0) continue;

    files.push({ path, language, bytes });
  }

  files.sort((left, right) => left.path.localeCompare(right.path));
  return { files, skipped };
}

/**
 * Index paths are POSIX on every platform: they are stored, compared against a
 * stored manifest, and printed as `path:line` citations. A separator that
 * varies by machine would make an index non-portable for no benefit.
 */
function toPosix(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}
