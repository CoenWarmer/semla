import { createClient } from "@/lib/supabase/server";
import { ClientSessionComponent } from "@/components/clientSessionComponent";
import { getPiRuntimeConfig } from "@/lib/pi/runtime-config";
import { notFound } from "next/navigation";

export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const supabase = await createClient();

  const { data: session, error } = await supabase
    .from("sessions")
    .select("id, title")
    .eq("id", id)
    .maybeSingle();

  if (error) {
    console.error(`[sessions/${id}] Failed to fetch session:`, error);
    throw new Error(`Unable to load session: ${error.message}`);
  }

  if (!session) {
    notFound();
  }

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      <ClientSessionComponent
        defaultTools={[...getPiRuntimeConfig().tools]}
        sessionId={id}
        title={session.title}
      />
    </div>
  );
}
