/**
 * The mechanism end to end, against a real SessionManager.
 *
 * resolveBranchTarget is pure and tested on its own, but the claim that matters
 * is about Pi's behaviour: that moving the leaf and appending really does
 * supersede a prompt without destroying anything. That is only provable by
 * doing it.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import { applyBranchTarget, resolveBranchTarget } from "./session-branch.ts";
import { readSessionEntries } from "./session-file.ts";

const userText = (row: { payload: { entry: { message?: unknown } } }) => {
  const message = row.payload.entry.message as
    | { content?: Array<{ text?: string; type?: string }>; role?: string }
    | undefined;
  if (message?.role !== "user") return null;
  return message.content?.find((part) => part.type === "text")?.text ?? null;
};

/** A three-turn session written the way Pi writes one. */
const seed = (dir: string) => {
  const manager = SessionManager.create(dir, dir);
  const first = manager.appendMessage({
    role: "user",
    content: [{ type: "text", text: "first prompt" }],
  } as never);
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "first answer" }],
  } as never);
  const second = manager.appendMessage({
    role: "user",
    content: [{ type: "text", text: "second prompt" }],
  } as never);
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "second answer" }],
  } as never);
  return { first, manager, second, sessionFile: manager.getSessionFile()! };
};

describe("editing a prompt against a real SessionManager", () => {
  it("supersedes the prompt and its answer without deleting either", () => {
    const dir = mkdtempSync(join(tmpdir(), "semla-branch-"));
    const { manager, second, sessionFile: file } = seed(dir);
    const linesBefore = readFileSync(file, "utf8").trim().split("\n").length;

    applyBranchTarget(manager, resolveBranchTarget(manager.getEntries(), second));
    manager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "second prompt, corrected" }],
    } as never);

    const linesAfter = readFileSync(file, "utf8").trim().split("\n").length;
    // Append-only: the file grew. Nothing was rewritten or removed.
    expect(linesAfter).toBeGreaterThan(linesBefore);

    const id = file.split("/").pop()!.replace(".jsonl", "");
    const live = readSessionEntries(id, dir)!;
    const prompts = live.map(userText).filter(Boolean);

    expect(prompts).toEqual(["first prompt", "second prompt, corrected"]);
    // The superseded answer is off the live path too — it replied to the old text.
    expect(JSON.stringify(live)).not.toContain("second answer");
    // But it is still in the file.
    expect(readFileSync(file, "utf8")).toContain("second answer");
  });

  it("re-edits the first prompt by resetting to root", () => {
    const dir = mkdtempSync(join(tmpdir(), "semla-branch-root-"));
    const { first, manager, sessionFile: file } = seed(dir);

    applyBranchTarget(manager, resolveBranchTarget(manager.getEntries(), first));
    manager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "first prompt, corrected" }],
    } as never);

    const id = file.split("/").pop()!.replace(".jsonl", "");
    const live = readSessionEntries(id, dir)!;

    expect(live.map(userText).filter(Boolean)).toEqual(["first prompt, corrected"]);
  });
});
