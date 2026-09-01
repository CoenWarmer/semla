import { describe, expect, it } from "vitest";

import { isOnSessionPage } from "@/components/sessions-list-client";

const ID = "08dfc25e-9742-48fd-8f20-6784a3ea228c";

describe("isOnSessionPage", () => {
  it("matches the session's own page", () => {
    expect(isOnSessionPage(`/sessions/${ID}`, ID)).toBe(true);
  });

  it("matches a page nested under the session", () => {
    // Deleting a session while reading one of its workflow runs used to leave
    // you on a page whose session no longer existed.
    expect(isOnSessionPage(`/sessions/${ID}/workflows/run-1`, ID)).toBe(true);
    expect(isOnSessionPage(`/sessions/${ID}/workflows/run-1/agents/2`, ID)).toBe(
      true,
    );
  });

  it("does not match a different session", () => {
    expect(isOnSessionPage("/sessions/other-id", ID)).toBe(false);
  });

  it("is not fooled by an id that merely starts the same way", () => {
    expect(isOnSessionPage(`/sessions/${ID}-copy`, ID)).toBe(false);
  });

  it("does not match elsewhere in the app", () => {
    expect(isOnSessionPage("/", ID)).toBe(false);
    expect(isOnSessionPage("/settings", ID)).toBe(false);
  });
});
