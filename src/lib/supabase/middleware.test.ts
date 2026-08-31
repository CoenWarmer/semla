/**
 * The proxy matches every route, and getClaims() cannot distinguish an invalid
 * token from an unreachable auth service — it yields no subject either way — so
 * with Supabase down it redirected the whole app to /login, including pages
 * that never touch the database.
 *
 * Bound to loopback there is nobody to authenticate and the gate is skipped
 * entirely. The policy comes from the bind address rather than the request,
 * because a Host header is set by the client.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const loadProxy = async (env: Record<string, string>) => {
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  return (await import("./middleware.ts")).updateSession;
};

const request = (pathname: string, host = "localhost:3000") =>
  ({
    headers: new Headers({ host }),
    cookies: { getAll: () => [], set: () => {} },
    nextUrl: {
      pathname,
      search: "",
      clone() {
        return { pathname, search: "", searchParams: new URLSearchParams() };
      },
    },
  }) as never;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("local access", () => {
  it("lets a request through without contacting Supabase", async () => {
    const updateSession = await loadProxy({ SEMLA_BIND_HOST: "127.0.0.1" });

    const response = await updateSession(request("/wiki"));

    // A redirect would mean it still tried to authenticate.
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
  });

  it("applies to every route, not just the wiki", async () => {
    const updateSession = await loadProxy({ SEMLA_BIND_HOST: "localhost" });

    expect((await updateSession(request("/sessions/abc"))).status).toBe(200);
  });
});

describe("exposed access", () => {
  // The header says localhost; the bind says otherwise, and the bind wins.
  // Otherwise anyone on the network could ask to be treated as local.
  it("still authenticates when bound to a public address", async () => {
    const updateSession = await loadProxy({
      SEMLA_BIND_HOST: "0.0.0.0",
      NEXT_PUBLIC_SUPABASE_URL: "https://example.invalid",
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "anon",
    });

    await expect(
      updateSession(request("/wiki", "localhost:3000")),
    ).rejects.toBeDefined();
  });
});
