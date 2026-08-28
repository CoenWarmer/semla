"use client";

import { startTransition, useEffect, useOptimistic, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { ItemGroup } from "@/components/ui/item";
import { SessionItem } from "@/components/session-item";
import { createClient } from "@/lib/supabase/client";

export type SessionRow = {
  id: string;
  date: string;
  isRunning: boolean;
  title: string | null;
  usage?: { tokens: number; cost: number };
};

export function SessionsListClient({ sessions }: { sessions: SessionRow[] }) {
  const router = useRouter();
  const pathname = usePathname();

  const [optimistic, removeOptimistically] = useOptimistic(
    sessions,
    (current, deletedId: string) => current.filter((s) => s.id !== deletedId),
  );

  // Realtime overrides keyed by session id — updated when Supabase pushes an UPDATE.
  const [runningMap, setRunningMap] = useState<Record<string, boolean>>(
    () => Object.fromEntries(sessions.map((s) => [s.id, s.isRunning])),
  );

  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel("sessions-running")
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "sessions" },
        (payload) => {
          const updated = payload.new as { id: string; is_running: boolean };
          setRunningMap((prev) => ({ ...prev, [updated.id]: updated.is_running }));
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, []);

  const handleDelete = (id: string) => {
    startTransition(async () => {
      removeOptimistically(id);
      await fetch(`/api/sessions/${id}`, { method: "DELETE" });
      router.refresh();
      if (pathname === `/sessions/${id}`) {
        router.push("/");
      }
    });
  };

  return (
    <ItemGroup className="max-w-sm">
      {optimistic.map((s) => (
        <SessionItem
          key={s.id}
          {...s}
          isRunning={runningMap[s.id] ?? s.isRunning}
          onDelete={handleDelete}
        />
      ))}
    </ItemGroup>
  );
}
