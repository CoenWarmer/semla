import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@/components/ui/item";
import { TokenUsage } from "@/components/token-usage";
import { createClient } from "@/lib/supabase/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.types";
import Link from "next/link";

async function getSessionTokenUsage(
  supabase: SupabaseClient<Database>,
  sessionIds: string[],
): Promise<Map<string, { tokens: number; cost: number }>> {
  if (sessionIds.length === 0) return new Map();

  const { data: piSessions } = await supabase
    .from("pi_sessions")
    .select("id, semla_session_id")
    .in("semla_session_id", sessionIds);

  if (!piSessions?.length) return new Map();

  const piIdToSemlaId = new Map(
    piSessions.map((ps) => [ps.id, ps.semla_session_id]),
  );

  const { data: entries } = await supabase
    .from("pi_session_entries")
    .select("pi_session_id, payload")
    .in("pi_session_id", [...piIdToSemlaId.keys()])
    .eq("event_type", "message");

  const usageMap = new Map<string, { tokens: number; cost: number }>();
  for (const entry of entries ?? []) {
    const semlaId = piIdToSemlaId.get(entry.pi_session_id);
    if (!semlaId) continue;
    const payload = entry.payload as Record<string, unknown>;
    const msg = (payload?.entry as Record<string, unknown>)?.message as
      | Record<string, unknown>
      | undefined;
    const usage = msg?.usage as Record<string, unknown> | undefined;
    if (!usage) continue;
    const tokens = Number(usage.totalTokens ?? 0);
    const cost = Number(
      (usage.cost as Record<string, unknown> | undefined)?.total ?? 0,
    );
    if (!tokens && !cost) continue;
    const prev = usageMap.get(semlaId) ?? { tokens: 0, cost: 0 };
    usageMap.set(semlaId, {
      tokens: prev.tokens + tokens,
      cost: prev.cost + cost,
    });
  }

  return usageMap;
}

export async function SessionsList() {
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return null;
  }

  const { data: sessions, error } = await supabase
    .from("sessions")
    .select("id, created_at, title")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("[sessionsList] Failed to load sessions:", error);
    return (
      <p className="text-destructive text-sm">
        Failed to load sessions. Please refresh the page.
      </p>
    );
  }

  if (!sessions?.length) {
    return null;
  }

  const usageBySession = await getSessionTokenUsage(
    supabase,
    sessions.map((s) => s.id),
  );

  return (
    <ItemGroup className="max-w-sm">
      {sessions.map(({ id, created_at, title }) => {
        const date = new Date(created_at).toLocaleDateString("nl-NL", {
          day: "2-digit",
          month: "2-digit",
          year: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        });
        const usage = usageBySession.get(id);
        return (
          <Item key={id} variant="outline" className="relative">
            <ItemContent className="gap-1">
              <ItemTitle>
                <Link
                  href={`/sessions/${id}`}
                  className="after:absolute after:inset-0"
                >
                  {title ?? "Untitled"}
                </Link>
              </ItemTitle>
              <ItemDescription className="flex flex-col justify-between gap-1">
                <span>{date}</span>
                {usage && (
                  <TokenUsage
                    className="text-xs"
                    cost={usage.cost}
                    tokens={usage.tokens}
                  />
                )}
              </ItemDescription>
            </ItemContent>
          </Item>
        );
      })}
    </ItemGroup>
  );
}
