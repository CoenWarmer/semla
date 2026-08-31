import { createClient } from "@/lib/supabase/server";
import { ClientSessionComponent } from "@/components/client-session-component";
import { getPiRuntimeConfig } from "@/lib/pi/runtime-config";
import { getTranscript } from "@/lib/pi/transcript";
import { readSessionMeta } from "@/lib/pi/session-meta";
import { notFound } from "next/navigation";

export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const supabase = await createClient();

  const [sessionResult, transcript] = await Promise.all([
    supabase.from("sessions").select("id, title, goal, is_running").eq("id", id).maybeSingle(),
    getTranscript(supabase, id).catch(() => null),
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
        initialMessagesData={transcript ? { contextWindow: null, ...transcript } : undefined}
        isRunning={session.is_running ?? false}
        sessionId={id}
        title={session.title}
      />
    </div>
  );
}
