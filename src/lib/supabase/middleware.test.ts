/**
 * The proxy matches every route and cannot distinguish an invalid token from an
 * unreachable auth service — `getClaims()` yields no subject either way — so a
 * Supabase outage redirects the whole app to /login, including pages that never
 * touch the database. The escape hatch has to work, and must not exist in
 * production.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const loadProxy = async (env: Record<string, string | undefined>) => {
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) vi.stubEnv(key, "");
    else vi.stubEnv(key, value);
  }
  return (await import("./middleware.ts")).updateSession;
};

const request = (pathname: string) =>
  ({
    headers: new Headers(),
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

describe("SEMLA_DISABLE_AUTH", () => {
  it("lets a request through without contacting Supabase", async () => {
    const updateSession = await loadProxy({
      NODE_ENV: "development",
      SEMLA_DISABLE_AUTH: "true",
    });

    const response = await updateSession(request("/wiki"));

    // A redirect would mean it still tried to authenticate.
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
  });

  it("is inert in production, whatever the variable says", async () => {
    const updateSession = await loadProxy({
      NODE_ENV: "production",
      SEMLA_DISABLE_AUTH: "true",
      NEXT_PUBLIC_SUPABASE_URL: "https://example.invalid",
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "anon",
    });

    // Reaching Supabase at all is the point: it must not short-circuit.
    await expect(updateSession(request("/wiki"))).rejects.toBeDefined();
  });

  it("is off unless explicitly set to true", async () => {
    const updateSession = await loadProxy({
      NODE_ENV: "development",
      SEMLA_DISABLE_AUTH: "1",
      NEXT_PUBLIC_SUPABASE_URL: "https://example.invalid",
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "anon",
    });

    await expect(updateSession(request("/wiki"))).rejects.toBeDefined();
  });
});
