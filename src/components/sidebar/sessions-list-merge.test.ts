/**
 * The sidebar is a server component in a layout, and App Router layouts persist
 * across client navigation — so a session created on the way to its own page
 * was absent from the rendered list and only appeared when something forced a
 * server re-render, which in practice was the title arriving after the agent's
 * first reply.
 */
import { describe, expect, it } from "vitest";

import { mergeDiscoveredSessions } from "./sessions-list-client.tsx";

const rendered = (id: string, createdAt: string) => ({
  id,
  createdAt,
  date: createdAt,
  isRunning: false,
  title: id,
});

const polled = (id: string, createdAt: string) => ({
  id,
  createdAt,
  title: id,
  isRunning: false,
  hasRun: false,
  projects: [],
});

describe("mergeDiscoveredSessions", () => {
  it("adds a session the server render did not have", () => {
    const merged = mergeDiscoveredSessions(
      [rendered("old", "2026-08-30T10:00:00.000Z")],
      [
        polled("old", "2026-08-30T10:00:00.000Z"),
        polled("brand-new", "2026-08-31T10:00:00.000Z"),
      ],
    );

    expect(merged.map((s) => s.id)).toEqual(["brand-new", "old"]);
  });

  // Prepending would be right for the session just created and wrong for one
  // that appeared in another tab.
  it("orders by timestamp rather than assuming the new one is newest", () => {
    const merged = mergeDiscoveredSessions(
      [rendered("newest", "2026-08-31T12:00:00.000Z")],
      [polled("older", "2026-08-29T10:00:00.000Z")],
    );

    expect(merged.map((s) => s.id)).toEqual(["newest", "older"]);
  });

  it("does not duplicate a session the server already rendered", () => {
    const merged = mergeDiscoveredSessions(
      [rendered("a", "2026-08-31T10:00:00.000Z")],
      [polled("a", "2026-08-31T10:00:00.000Z")],
    );

    expect(merged).toHaveLength(1);
  });

  // Keeps the server's own rows and ordering untouched, including the usage
  // figures the poll knows nothing about.
  it("returns the rendered list unchanged when there is nothing new", () => {
    const list = [
      rendered("a", "2026-08-31T10:00:00.000Z"),
      rendered("b", "2026-08-30T10:00:00.000Z"),
    ];

    expect(mergeDiscoveredSessions(list, [polled("a", "2026-08-31T10:00:00.000Z")])).toBe(
      list,
    );
  });

  it("survives a rendered row with no timestamp", () => {
    const withoutDate = { id: "legacy", date: "01-01-26", isRunning: false, title: null };

    const merged = mergeDiscoveredSessions(
      [withoutDate],
      [polled("new", "2026-08-31T10:00:00.000Z")],
    );

    expect(merged.map((s) => s.id)).toEqual(["legacy", "new"]);
  });
});

/**
 * Deleting undid itself: the row left the rendered list at once, but the status
 * poll still listed the session until its own refetch landed, and the merge
 * read that as "a session the server render is missing" and put it back.
 */
describe("deleted sessions", () => {
  // The reported bug: delete from the sidebar menu, navigate home, and the row
  // was still there until a full page load. The optimistic removal expires with
  // its transition, and the list behind it lives in a layout that persists
  // across navigation, so the deleted session came back from a stale render.
  it("drops a deleted session that the server render still lists", () => {
    const merged = mergeDiscoveredSessions(
      [rendered("gone", "2026-08-31T10:00:00.000Z"), rendered("kept", "2026-08-30T10:00:00.000Z")],
      [],
      new Set(["gone"]),
    );

    expect(merged.map((s) => s.id)).toEqual(["kept"]);
  });

  it("drops it whether or not the poll also still lists it", () => {
    const merged = mergeDiscoveredSessions(
      [rendered("gone", "2026-08-31T10:00:00.000Z")],
      [polled("gone", "2026-08-31T10:00:00.000Z")],
      new Set(["gone"]),
    );

    expect(merged).toEqual([]);
  });

  it("does not re-add a session that was just deleted", () => {
    const merged = mergeDiscoveredSessions(
      [],
      [polled("gone", "2026-08-31T10:00:00.000Z")],
      new Set(["gone"]),
    );

    expect(merged).toEqual([]);
  });

  it("still adds the sessions that were not deleted", () => {
    const merged = mergeDiscoveredSessions(
      [],
      [
        polled("gone", "2026-08-31T10:00:00.000Z"),
        polled("kept", "2026-08-31T11:00:00.000Z"),
      ],
      new Set(["gone"]),
    );

    expect(merged.map((s) => s.id)).toEqual(["kept"]);
  });
});
