import { describe, expect, it } from "vitest";

import type { FileSelection } from "./review-changed-files";
import {
  canGoBack,
  canGoForward,
  currentFileHistoryEntry,
  goBack,
  goForward,
  INITIAL_FILE_HISTORY,
  pushFileHistory,
} from "./review-file-history.ts";

const a: FileSelection = { path: "src/a.ts", project: "app" };
const b: FileSelection = { path: "src/b.ts", project: "app" };
const c: FileSelection = { path: "src/c.ts", project: "app" };

describe("pushFileHistory", () => {
  it("starts empty", () => {
    expect(canGoBack(INITIAL_FILE_HISTORY)).toBe(false);
    expect(canGoForward(INITIAL_FILE_HISTORY)).toBe(false);
    expect(currentFileHistoryEntry(INITIAL_FILE_HISTORY)).toBeNull();
  });

  it("records the first open", () => {
    const state = pushFileHistory(INITIAL_FILE_HISTORY, a);
    expect(currentFileHistoryEntry(state)).toEqual(a);
    expect(canGoBack(state)).toBe(false);
    expect(canGoForward(state)).toBe(false);
  });

  it("is a no-op for a null selection", () => {
    expect(pushFileHistory(INITIAL_FILE_HISTORY, null)).toBe(
      INITIAL_FILE_HISTORY,
    );
  });

  it("is a no-op for re-selecting the current file", () => {
    const opened = pushFileHistory(INITIAL_FILE_HISTORY, a);
    const reselected = pushFileHistory(opened, { ...a });
    expect(reselected).toBe(opened);
  });

  it("appends distinct opens and allows stepping back", () => {
    let state = pushFileHistory(INITIAL_FILE_HISTORY, a);
    state = pushFileHistory(state, b);
    state = pushFileHistory(state, c);
    expect(currentFileHistoryEntry(state)).toEqual(c);

    expect(canGoBack(state)).toBe(true);
    state = goBack(state);
    expect(currentFileHistoryEntry(state)).toEqual(b);
    expect(canGoForward(state)).toBe(true);

    state = goBack(state);
    expect(currentFileHistoryEntry(state)).toEqual(a);
    expect(canGoBack(state)).toBe(false);
  });

  it("goBack/goForward are no-ops at either end", () => {
    let state = pushFileHistory(INITIAL_FILE_HISTORY, a);
    state = pushFileHistory(state, b);

    const atStart = goBack(goBack(state));
    expect(currentFileHistoryEntry(atStart)).toEqual(a);
    expect(goBack(atStart)).toBe(atStart);

    const atEnd = goForward(goForward(state));
    expect(currentFileHistoryEntry(atEnd)).toEqual(b);
    expect(goForward(atEnd)).toBe(atEnd);
  });

  it("opening a new file while not at the newest entry discards the forward entries", () => {
    let state = pushFileHistory(INITIAL_FILE_HISTORY, a);
    state = pushFileHistory(state, b);
    state = pushFileHistory(state, c);

    state = goBack(state); // back to b, c still reachable forward
    expect(currentFileHistoryEntry(state)).toEqual(b);
    expect(canGoForward(state)).toBe(true);

    const project: FileSelection = { path: "src/new.ts", project: "app" };
    state = pushFileHistory(state, project);

    expect(currentFileHistoryEntry(state)).toEqual(project);
    expect(canGoForward(state)).toBe(false);
    expect(canGoBack(state)).toBe(true);

    state = goBack(state);
    expect(currentFileHistoryEntry(state)).toEqual(b);
    expect(canGoBack(state)).toBe(true);

    state = goBack(state);
    expect(currentFileHistoryEntry(state)).toEqual(a);
  });

  it("stepping back and forward never pushes a new entry", () => {
    let state = pushFileHistory(INITIAL_FILE_HISTORY, a);
    state = pushFileHistory(state, b);
    const afterOpens = state;

    state = goBack(state);
    state = goForward(state);

    expect(state.entries).toEqual(afterOpens.entries);
    expect(state.index).toBe(afterOpens.index);
  });
});
