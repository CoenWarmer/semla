import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const gitMock = vi.hoisted(() => vi.fn());
let interval = 60_000;

vi.mock("./git", () => ({ git: gitMock }));
vi.mock("./runtime-config", () => ({
  get GIT_FETCH_INTERVAL_MS() {
    return interval;
  },
}));

const { fetchNow, refreshRemote, resetFetchStateForTests } =
  await import("./git-fetch");

/**
 * Let the fetch's promise chain settle. `refreshRemote` clears its in-flight
 * entry in a `.finally`, which is a microtask — nothing observable happens
 * until the queue drains, and fake timers do not drain it.
 */
const settle = () => new Promise((resolve) => process.nextTick(resolve));

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

describe("fetchNow", () => {
  beforeEach(() => {
    interval = 60_000;
    gitMock.mockReset();
    gitMock.mockResolvedValue(null);
    resetFetchStateForTests();
    vi.useFakeTimers();
  });

  afterEach(() => vi.useRealTimers());

  it("waits for the fetch rather than starting one", async () => {
    let done = false;
    gitMock.mockImplementation(async () => {
      done = true;
      return null;
    });
    await fetchNow("/repo", "upstream", "main");
    // The popover shows these numbers immediately after; returning early would
    // show exactly the stale ones it was opened to escape.
    expect(done).toBe(true);
  });

  it("ignores the throttle, because the user asked", async () => {
    refreshRemote("/repo", "upstream", "main");
    await settle();
    vi.advanceTimersByTime(1_000);
    expect(refreshRemote("/repo", "upstream", "main")).toBe(false); // throttled
    await fetchNow("/repo", "upstream", "main");
    expect(gitMock).toHaveBeenCalledTimes(2);
  });

  it("joins a background fetch already running instead of racing it", async () => {
    const release = pendingFetch();
    refreshRemote("/repo", "upstream", "main");
    const joined = fetchNow("/repo", "upstream", "main");
    expect(gitMock).toHaveBeenCalledTimes(1);
    release();
    await joined;
  });

  it("resolves even when the fetch fails", async () => {
    gitMock.mockRejectedValue(new Error("offline"));
    await expect(fetchNow("/repo", "upstream", "main")).resolves.toBeUndefined();
  });

  it("still fetches one branch only", async () => {
    await fetchNow("/repo", "upstream", "main");
    expect(gitMock).toHaveBeenCalledWith(
      "/repo",
      ["fetch", "upstream", "main", "--quiet", "--no-tags"],
      expect.objectContaining({ network: true }),
    );
  });
});
