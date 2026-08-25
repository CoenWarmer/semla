import { createClient } from "@/lib/supabase/server";
import { ClientSessionComponent } from "@/components/clientSessionComponent";
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
    // If the goal column doesn't exist yet (pending migration), retry without it.
    if (sessionResult.error.message.includes("goal")) {
      const fallback = await supabase
        .from("sessions")
        .select("id, title")
        .eq("id", id)
        .maybeSingle();
      if (fallback.error) {
        console.error(`[sessions/${id}] Failed to fetch session:`, fallback.error);
        throw new Error(`Unable to load session: ${fallback.error.message}`);
      }
      if (!fallback.data) notFound();
      return (
        <div className="flex h-full w-full flex-col overflow-hidden">
          <ClientSessionComponent
            defaultTools={[...getPiRuntimeConfig().tools]}
            initialMessagesData={transcript ? { contextWindow: null, ...transcript } : undefined}
            sessionId={id}
            title={fallback.data.title}
          />
        </div>
      );
    }
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
