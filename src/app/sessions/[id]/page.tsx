import { createClient } from "@/lib/supabase/server";
import { ClientSessionComponent } from "@/components/client-session-component";
import { getPiRuntimeConfig } from "@/lib/pi/runtime-config";
import { getTranscript } from "@/lib/pi/transcript";
import { notFound } from "next/navigation";

export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const supabase = await createClient();

  const [sessionResult, transcript] = await Promise.all([
    supabase.from("sessions").select("id, title, goal").eq("id", id).maybeSingle(),
    getTranscript(supabase, id).catch(() => null),
  ]);

  if (sessionResult.error) {
    console.error(`[sessions/${id}] Failed to fetch session:`, sessionResult.error);
    throw new Error(`Unable to load session: ${sessionResult.error.message}`);
  }

  if (!sessionResult.data) {
    notFound();
  }

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      <ClientSessionComponent
        defaultTools={[...getPiRuntimeConfig().tools]}
        goal={sessionResult.data.goal}
        initialMessagesData={transcript ? { contextWindow: null, ...transcript } : undefined}
        sessionId={id}
        title={sessionResult.data.title}
      />
    </div>
  );
}
