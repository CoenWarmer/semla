import { updateSession } from "@/lib/supabase/middleware";

export const proxy = updateSession;

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
