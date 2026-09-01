import { requireUser } from "@/lib/api-helpers";
import { createClient } from "@/lib/supabase/server";
import { ClientSessionComponent } from "@/components/client-session-component";
import { getPiRuntimeConfig } from "@/lib/pi/runtime-config";
import { buildSessionMessages } from "@/lib/pi/session-messages-payload";
import { readSessionMeta } from "@/lib/pi/session-meta";
import { notFound } from "next/navigation";

export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

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

  if (!session) {
    notFound();
  }

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      <ClientSessionComponent
        defaultTools={[...getPiRuntimeConfig().tools]}
        goal={session.goal}
        initialMessagesData={transcript ?? undefined}
        isRunning={session.is_running ?? false}
        sessionId={id}
        title={session.title}
      />
    </div>
  );
}
