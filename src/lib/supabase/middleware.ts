import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

/**
 * Skip the auth gate entirely, for working through a Supabase outage.
 *
 * The proxy matches every route, and it cannot tell "this token is invalid"
 * from "the auth service is unreachable" — `getClaims()` simply yields no
 * subject either way, so an outage redirects every page to /login, which then
 * cannot authenticate either. That takes down parts of the app that do not need
 * a database at all: the wiki is read from the filesystem and neither of its
 * routes calls Supabase.
 *
 * Refuses to engage outside development, because an env var that disables
 * authentication is worth exactly one accident.
 */
const AUTH_DISABLED =
  process.env.NODE_ENV !== "production" &&
  process.env.SEMLA_DISABLE_AUTH === "true";

let warned = false;

export const updateSession = async (request: NextRequest) => {
  if (AUTH_DISABLED) {
    if (!warned) {
      warned = true;
      console.warn(
        "[auth] SEMLA_DISABLE_AUTH is set — every request is unauthenticated. " +
          "Filesystem-backed pages such as /wiki work; anything reading Supabase " +
          "still fails, because the database is what is unavailable.",
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
