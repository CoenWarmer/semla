import { describe, expect, it } from "vitest";

import { newSessionHref } from "@/components/projects-grid";

describe("newSessionHref", () => {
  it("points at a session that does not exist yet, carrying the project", () => {
    // Deferred creation: the card no longer POSTs a session before navigating,
    // so the project has to survive the trip in the URL.
    expect(newSessionHref("semla")).toBe("/sessions/new?project=semla");
  });

  it("encodes a name that would otherwise break the query string", () => {
    // Project names are directory names, which may hold anything a filesystem
    // allows — a bare one would truncate the parameter or start a new one.
    expect(newSessionHref("my repo")).toBe("/sessions/new?project=my%20repo");
    expect(newSessionHref("a&b=c")).toBe("/sessions/new?project=a%26b%3Dc");
    expect(newSessionHref("feature/thing")).toBe(
      "/sessions/new?project=feature%2Fthing",
    );
  });
});
