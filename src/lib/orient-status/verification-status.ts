/**
 * Reading and writing `verification.json`, phase 3's status file.
 *
 * Three states a reader has to be able to tell apart, none of which is an
 * exception:
 *
 * - **never-run** — no file. A first-class state, exactly as "not indexed" is
 *   for the code index.
 * - **unreadable** — the file exists but does not parse, or does not have the
 *   shape. Reported to the caller, not thrown: orient's job is to say what it
 *   knows, and a status reader that throws turns a recoverable "re-run phase 3"
 *   into a failed turn.
 * - **orphaned** — the file's `root` is not this project. That is what a
 *   changed `projectKey` derivation looks like from here, and the reason the
 *   absolute root is stored at all.
 *
 * Plain write, no read-modify-write and no lock — see paths.ts on why one file
 * per phase removes the race rather than guarding it.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { VerificationSignal } from "@/lib/verification-signals/types";

import { orientStatusPaths } from "./paths";

export interface VerificationStatus {
  /** Absolute project root this describes; also detects an orphaned directory. */
  root: string;
  /** ISO 8601. */
  capturedAt: string;
  /** sha256 over the exact input files read. See verification-signals/digest.ts. */
  inputsDigest: string;
  signals: VerificationSignal[];
}

export type VerificationStatusRead =
  | { kind: "ok"; status: VerificationStatus; path: string }
  | { kind: "never-run"; path: string }
  | { kind: "unreadable"; path: string; reason: string }
  | { kind: "orphaned"; path: string; recordedRoot: string; expectedRoot: string };

export async function readVerificationStatus(
  projectRoot: string,
): Promise<VerificationStatusRead> {
  const root = resolve(projectRoot);
  const { verification: path } = orientStatusPaths(root);

  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT") return { kind: "never-run", path };
    return {
      kind: "unreadable",
      path,
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      kind: "unreadable",
      path,
      reason: `not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const status = asVerificationStatus(parsed);
  if (status === null) {
    return { kind: "unreadable", path, reason: "not a VerificationStatus object" };
  }
  if (resolve(status.root) !== root) {
    return { kind: "orphaned", path, expectedRoot: root, recordedRoot: status.root };
  }
  return { kind: "ok", path, status };
}

export interface WriteVerificationStatusOptions {
  root: string;
  capturedAt: string;
  inputsDigest: string;
  signals: VerificationSignal[];
}

export async function writeVerificationStatus(
  options: WriteVerificationStatusOptions,
): Promise<{ path: string; status: VerificationStatus }> {
  const root = resolve(options.root);
  const paths = orientStatusPaths(root);
  await mkdir(paths.dir, { recursive: true });

  const status: VerificationStatus = {
    capturedAt: options.capturedAt,
    inputsDigest: options.inputsDigest,
    root,
    signals: options.signals,
  };
  await writeFile(paths.verification, `${JSON.stringify(status, null, 2)}\n`, "utf8");
  return { path: paths.verification, status };
}

/** True when the recorded digest no longer matches the tree's current inputs. */
export function isVerificationStale(
  read: VerificationStatusRead,
  currentDigest: string,
): boolean {
  // Anything other than a readable, matching record means phase 3 has nothing
  // trustworthy on disk, which is stale by any useful definition.
  if (read.kind !== "ok") return true;
  return read.status.inputsDigest !== currentDigest;
}

function asVerificationStatus(value: unknown): VerificationStatus | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.root !== "string" ||
    typeof record.capturedAt !== "string" ||
    typeof record.inputsDigest !== "string" ||
    !Array.isArray(record.signals)
  ) {
    return null;
  }
  return {
    capturedAt: record.capturedAt,
    inputsDigest: record.inputsDigest,
    root: record.root,
    signals: record.signals as VerificationSignal[],
  };
}
