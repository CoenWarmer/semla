import { createServerClient } from "@supabase/ssr";

import { AUTH_REQUIRED, BIND_HOST } from "@/lib/auth-mode";
import { type NextRequest, NextResponse } from "next/server";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

/**
 * Semla bound to loopback authenticates nobody: nothing off this machine can
 * reach it, and requiring an auth round trip there made a Supabase outage take
 * down pages that need no database at all. See lib/auth-mode.ts for why the
 * decision comes from the bind address rather than the request.
 */
let warned = false;

export const updateSession = async (request: NextRequest) => {
  if (!AUTH_REQUIRED) {
    if (!warned) {
      warned = true;
      console.log(
        `[auth] bound to ${BIND_HOST} — local access, no sign-in required. ` +
          "Set SEMLA_BIND_HOST to expose Semla, which turns authentication on.",
      );
    }
    return NextResponse.next({ request: { headers: request.headers } });
  }

  let supabaseResponse = NextResponse.next({
    request: {
      headers: request.headers,
    },
  });

  const supabase = createServerClient(supabaseUrl!, supabaseKey!, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) =>
          request.cookies.set(name, value),
        );
        supabaseResponse = NextResponse.next({
          request,
        });
        cookiesToSet.forEach(({ name, value, options }) =>
          supabaseResponse.cookies.set(name, value, options),
        );
      },
    },
  });

  const { data: claimsData } = await supabase.auth.getClaims();
  const userId = claimsData?.claims.sub;

  const isLoginPage = request.nextUrl.pathname === "/login";
  const redirectWithSessionCookies = (url: URL) => {
    const response = NextResponse.redirect(url);

    supabaseResponse.cookies
      .getAll()
      .forEach((cookie) => response.cookies.set(cookie));

    return response;
  };

  if (!userId && !isLoginPage) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set(
      "next",
      `${request.nextUrl.pathname}${request.nextUrl.search}`,
    );
    return redirectWithSessionCookies(url);
  }

  if (userId && isLoginPage) {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    url.search = "";
    return redirectWithSessionCookies(url);
  }

  return supabaseResponse;
};
