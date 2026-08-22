import { createClient } from "@/app/utils/supabase/server";
import { ClientSessionComponent } from "@/components/clientSessionComponent";

export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const supabase = await createClient();

  const { data: semlaSession } = await supabase
    .from("sessions")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  return (
    <div>
      Session: {id}
      Title: {semlaSession?.title}
      <ClientSessionComponent sessionId={id} />
    </div>
  );
}
