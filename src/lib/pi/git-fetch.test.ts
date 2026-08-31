import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const gitMock = vi.hoisted(() => vi.fn());
let interval = 60_000;

vi.mock("./git", () => ({ git: gitMock }));
vi.mock("./runtime-config", () => ({
  get GIT_FETCH_INTERVAL_MS() {
    return interval;
  },
}));

const { refreshRemote, resetFetchStateForTests } = await import("./git-fetch");

/**
 * Let the fetch's promise chain settle. `refreshRemote` clears its in-flight
 * entry in a `.finally`, which is a microtask — nothing observable happens
 * until the queue drains, and fake timers do not drain it.
 */
const settle = () => new Promise(process.nextTick);

/** A fetch that stays pending until released, to observe in-flight behaviour. */
function pendingFetch() {
  let release!: () => void;
  const promise = new Promise<null>((resolve) => {
    release = () => resolve(null);
  });
  gitMock.mockReturnValue(promise);
  return release;
}

describe("refreshRemote", () => {
  beforeEach(() => {
    interval = 60_000;
    gitMock.mockReset();
    gitMock.mockResolvedValue(null);
    resetFetchStateForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fetches one branch, not the whole remote", () => {
    // The bug this pins: fetching every branch of elastic/kibana took 524
    // seconds against 2 for a single branch, so the 30s timeout killed it
    // every time and the tracking ref never moved.
    expect(refreshRemote("/repo", "upstream", "main")).toBe(true);
    expect(gitMock).toHaveBeenCalledWith(
      "/repo",
      ["fetch", "upstream", "main", "--quiet", "--no-tags"],
      expect.objectContaining({ network: true }),
    );
  });

  it("refuses prompts, so a missing credential cannot hang the fetch", () => {
    refreshRemote("/repo", "origin", "main");
    expect(gitMock.mock.calls[0][2]).toMatchObject({ network: true });
    // A fetch is far slower than a ref read; it needs its own budget.
    expect(gitMock.mock.calls[0][2].timeout).toBeGreaterThan(10_000);
  });

  it("throttles repeat reads of the same repo", async () => {
    expect(refreshRemote("/repo", "origin", "main")).toBe(true);
    expect(refreshRemote("/repo", "origin", "main")).toBe(true); // still in flight
    await settle();
    vi.advanceTimersByTime(30_000);
    expect(refreshRemote("/repo", "origin", "main")).toBe(false);
    expect(gitMock).toHaveBeenCalledTimes(1);
  });

  it("fetches again once the interval has passed", async () => {
    refreshRemote("/repo", "origin", "main");
    await settle();
    vi.advanceTimersByTime(61_000);
    expect(refreshRemote("/repo", "origin", "main")).toBe(true);
    expect(gitMock).toHaveBeenCalledTimes(2);
  });

  it("throttles each repository independently", () => {
    refreshRemote("/one", "origin", "main");
    refreshRemote("/two", "origin", "main");
    expect(gitMock).toHaveBeenCalledTimes(2);
  });

  it("collapses concurrent readers onto a single fetch", async () => {
    const release = pendingFetch();
    expect(refreshRemote("/repo", "origin", "main")).toBe(true);
    expect(refreshRemote("/repo", "origin", "main")).toBe(true);
    expect(gitMock).toHaveBeenCalledTimes(1);
    release();
  });

  it("still throttles after a failure, rather than retrying every poll", async () => {
    // The throttle keys off the attempt, not the outcome: an unreachable
    // remote must not mean a fetch attempt on every single read.
    gitMock.mockRejectedValue(new Error("offline"));
    expect(refreshRemote("/repo", "origin", "main")).toBe(true);
    await settle();
    vi.advanceTimersByTime(10_000);
    expect(refreshRemote("/repo", "origin", "main")).toBe(false);
    expect(gitMock).toHaveBeenCalledTimes(1);
  });

  it("does nothing at all when fetching is switched off", () => {
    interval = 0;
    expect(refreshRemote("/repo", "origin", "main")).toBe(false);
    expect(gitMock).not.toHaveBeenCalled();
  });
});
