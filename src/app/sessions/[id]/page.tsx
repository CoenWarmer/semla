import { requireUser } from "@/lib/api-helpers";
import { createClient } from "@/lib/supabase/server";
import { ClientSessionComponent } from "@/components/client-session-component";
import { getPiRuntimeConfig } from "@/lib/pi/runtime-config";
import { buildSessionMessages } from "@/lib/pi/session-messages-payload";
import { readSessionMeta } from "@/lib/pi/session-meta";
import { notFound } from "next/navigation";

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ new?: string }>;
}) {
  const [{ id }, { new: isNew }] = await Promise.all([params, searchParams]);

  const supabase = await createClient();
  const { user } = await requireUser();

  // The whole payload the messages route would return, not a subset. It is
  // seeded as the query's initialData, and a query with initialData does not
  // refetch while it is fresh — so a field missing here is missing on screen.
  const [sessionResult, transcript] = await Promise.all([
    supabase.from("sessions").select("id, title, goal, is_running").eq("id", id).maybeSingle(),
    buildSessionMessages(supabase, id, user.id).catch(() => null),
  ]);

  // The disk record is authoritative and available without the database; the
  // Postgres row still answers for sessions created before it existed.
  const meta = readSessionMeta(id);
  const session = meta
    ? { goal: meta.goal, is_running: meta.isRunning, title: meta.title }
    : sessionResult.data;

  if (!meta && sessionResult.error) {
    console.error(`[sessions/${id}] Failed to fetch session:`, sessionResult.error);
    throw new Error(`Unable to load session: ${sessionResult.error.message}`);
  }

  /**
   * A session whose record does not exist yet, rather than one that never did.
   *
   * /sessions/new mints the id and navigates immediately, so this page is
   * reached — and prefetched — before the row is written; the client creates it
   * as it submits the first prompt. Without this the prefetch would render a
   * 404 and cache it, which is the whole reason the navigation could not be
   * made instant before.
   *
   * Narrow on purpose: only an explicit `new=1` gets the shell, so a mistyped
   * or deleted session is still a 404 rather than an empty page that looks like
   * it worked.
   */
  const pendingCreation = !session && isNew === "1";

  if (!session && !pendingCreation) {
    notFound();
  }

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      <ClientSessionComponent
        defaultTools={[...getPiRuntimeConfig().tools]}
        goal={session?.goal ?? null}
        initialMessagesData={transcript ?? undefined}
        isRunning={session?.is_running ?? false}
        sessionId={id}
        title={session?.title ?? null}
      />
    </div>
  );
}
