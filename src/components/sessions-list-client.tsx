"use client";

import { startTransition, useOptimistic } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { ItemGroup } from "@/components/ui/item";
import { SessionItem } from "@/components/session-item";

export type SessionRow = {
  id: string;
  date: string;
  isRunning: boolean;
  title: string | null;
  usage?: { tokens: number; cost: number };
};

type SessionStatus = { id: string; isRunning: boolean; hasRun: boolean };

const fetchStatus = async (): Promise<SessionStatus[]> => {
  const response = await fetch("/api/sessions/status");
  if (!response.ok) throw new Error("Unable to load session status.");
  return ((await response.json()) as { sessions: SessionStatus[] }).sessions;
};

export function SessionsListClient({ sessions }: { sessions: SessionRow[] }) {
  const router = useRouter();
  const pathname = usePathname();

  const [optimistic, removeOptimistically] = useOptimistic(
    sessions,
    (current, deletedId: string) => current.filter((s) => s.id !== deletedId),
  );

  // Polled from disk rather than pushed over Realtime: is_running lives in the
  // session record now, so the sidebar follows it without a database.
  const { data: status } = useQuery({
    queryKey: ["session-status"],
    queryFn: fetchStatus,
    // Quick while something is running, because that is when it changes;
    // otherwise slow enough to be free. Paused automatically in a background
    // tab, where nobody is watching a spinner.
    refetchInterval: (query) =>
      (query.state.data ?? []).some((s) => s.isRunning) ? 2_000 : 15_000,
  });

  const statusById = new Map((status ?? []).map((s) => [s.id, s]));

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
          hasRun={statusById.get(s.id)?.hasRun ?? false}
          isRunning={statusById.get(s.id)?.isRunning ?? s.isRunning}
          onDelete={handleDelete}
        />
      ))}
    </ItemGroup>
  );
}
