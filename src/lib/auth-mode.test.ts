/**
 * The policy is derived from the bind address rather than the request on
 * purpose. A per-request "is this localhost?" test could only read the Host
 * header, which the client sets, and NextRequest exposes no peer address to
 * check it against — so an attacker on the network could simply ask to be
 * treated as local. Binding to loopback is enforced by the socket instead.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { isLoopbackHost } from "./auth-mode.ts";

const load = async (env: Record<string, string>) => {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  return import("./auth-mode.ts");
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("isLoopbackHost", () => {
  it.each(["127.0.0.1", "127.1.2.3", "localhost", "LOCALHOST", "::1", "[::1]"])(
    "treats %s as reachable only from this machine",
    (host) => {
      expect(isLoopbackHost(host)).toBe(true);
    },
  );

  // Every one of these accepts connections from elsewhere.
  it.each(["0.0.0.0", "192.168.1.10", "10.0.0.5", "::", "example.com"])(
    "treats %s as exposed",
    (host) => {
      expect(isLoopbackHost(host)).toBe(false);
    },
  );
});

describe("AUTH_REQUIRED", () => {
  it("is off by default, since the default bind is loopback", async () => {
    const { AUTH_REQUIRED, BIND_HOST } = await load({ SEMLA_BIND_HOST: "" });

    expect(BIND_HOST).toBe("127.0.0.1");
    expect(AUTH_REQUIRED).toBe(false);
  });

  // The point of the design: you cannot expose Semla without turning auth on,
  // because one variable drives both the socket and the policy.
  it.each(["0.0.0.0", "192.168.1.10"])("is on when bound to %s", async (host) => {
    const { AUTH_REQUIRED } = await load({ SEMLA_BIND_HOST: host });

    expect(AUTH_REQUIRED).toBe(true);
  });
});

describe("localUserId", () => {
  it("uses SEMLA_LOCAL_USER_ID when given one", async () => {
    const { localUserId } = await load({
      SEMLA_BIND_HOST: "127.0.0.1",
      SEMLA_LOCAL_USER_ID: "9b00564c-0f56-498c-a5d0-d4ebcc0f8802",
      PI_SESSION_DIR: "/nonexistent",
    });

    expect(localUserId()).toBe("9b00564c-0f56-498c-a5d0-d4ebcc0f8802");
  });

  it("falls back to a fixed id when no records exist to infer from", async () => {
    const { localUserId } = await load({
      SEMLA_BIND_HOST: "127.0.0.1",
      SEMLA_LOCAL_USER_ID: "",
      PI_SESSION_DIR: "/nonexistent",
    });

    expect(localUserId()).toMatch(/^[0-9a-f-]{36}$/);
  });
});
