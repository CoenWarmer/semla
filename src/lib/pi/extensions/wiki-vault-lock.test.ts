/**
 * The lock exists to stop two concurrent orients from silently losing a source
 * (pi-llm-wiki allocates ids read-then-write), so mutual exclusion is asserted
 * directly rather than assumed from the mkdir primitive.
 */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { isStale, withVaultLock, type LockHolder } from "./wiki-vault-lock.ts";

const vault = () => {
  const home = mkdtempSync(join(tmpdir(), "semla-lock-"));
  mkdirSync(join(home, ".llm-wiki", "meta"), { recursive: true });
  return home;
};

const lockPath = (home: string) => join(home, ".llm-wiki", "meta", ".lock");

describe("withVaultLock", () => {
  it("serialises overlapping critical sections", async () => {
    const home = vault();
    const log: string[] = [];

    const section = async (id: string) => {
      await withVaultLock(home, id, async () => {
        log.push(`enter:${id}`);
        await new Promise((r) => setTimeout(r, 10));
        log.push(`exit:${id}`);
      });
    };

    await Promise.all([section("a"), section("b"), section("c")]);

    // Every enter is immediately followed by its own exit.
    for (let i = 0; i < log.length; i += 2) {
      expect(log[i + 1]).toBe(log[i]!.replace("enter:", "exit:"));
    }
    expect(log).toHaveLength(6);
  });

  it("emulates the id race it exists to prevent", async () => {
    const home = vault();
    const dir = join(home, ".llm-wiki", "raw", "sources");
    mkdirSync(dir, { recursive: true });

    // Read-then-write, exactly like nextSequentialId.
    const claimId = async () => {
      const existing = (await import("node:fs")).readdirSync(dir).length;
      await new Promise((r) => setTimeout(r, 5)); // the window
      const id = `SRC-${String(existing + 1).padStart(3, "0")}`;
      mkdirSync(join(dir, id), { recursive: true });
      return id;
    };

    const ids = await Promise.all(
      ["a", "b", "c", "d"].map((label) => withVaultLock(home, label, claimId)),
    );

    expect(new Set(ids).size).toBe(4);
  });

  it("releases the lock when the section throws", async () => {
    const home = vault();

    await expect(
      withVaultLock(home, "boom", () => {
        throw new Error("capture failed");
      }),
    ).rejects.toThrow("capture failed");

    expect(existsSync(lockPath(home))).toBe(false);
    // The vault is not wedged for the next caller.
    await expect(withVaultLock(home, "next", () => "ok")).resolves.toBe("ok");
  });

  it("breaks a lock abandoned by a dead holder", async () => {
    const home = vault();
    mkdirSync(lockPath(home), { recursive: true });
    writeFileSync(
      join(lockPath(home), "holder.json"),
      // PID 1 exists, so use an age far past the staleness window instead.
      JSON.stringify({ pid: process.pid, label: "crashed", acquiredAt: 0 }),
      "utf8",
    );

    await expect(withVaultLock(home, "recovering", () => "ok")).resolves.toBe("ok");
  });

  it("creates the lock on a vault with no meta directory yet", async () => {
    const home = mkdtempSync(join(tmpdir(), "semla-lock-bare-"));

    await expect(withVaultLock(home, "first", () => "ok")).resolves.toBe("ok");
  });
});

describe("isStale", () => {
  const holder = (over: Partial<LockHolder> = {}): LockHolder => ({
    pid: process.pid,
    label: "test",
    acquiredAt: Date.now(),
    ...over,
  });

  it("treats a missing holder as stale", () => {
    expect(isStale(null, Date.now())).toBe(true);
  });

  it("treats a live, recent holder as held", () => {
    expect(isStale(holder(), Date.now())).toBe(false);
  });

  it("treats an old holder as stale even when the pid is alive", () => {
    expect(isStale(holder({ acquiredAt: 0 }), Date.now())).toBe(true);
  });

  it("treats a vanished pid as stale", () => {
    // Unused high pid; if it happens to exist the age check still applies.
    expect(isStale(holder({ pid: 999_999 }), Date.now())).toBe(true);
  });
});
