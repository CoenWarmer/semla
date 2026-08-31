"use client";

import { startTransition, useOptimistic, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ItemGroup } from "@/components/ui/item";
import { SessionItem } from "@/components/session-item";
import { formatSessionDate } from "@/lib/session-date";

export type SessionRow = {
  id: string;
  date: string;
  /** Raw timestamp, kept so merged rows can be ordered rather than guessed at. */
  createdAt?: string;
  isRunning: boolean;
  title: string | null;
  usage?: { tokens: number; cost: number };
};

export const SESSION_STATUS_KEY = ["session-status"] as const;

type SessionStatus = {
  id: string;
  title: string | null;
  createdAt: string;
  isRunning: boolean;
  hasRun: boolean;
};

const fetchStatus = async (): Promise<SessionStatus[]> => {
  const response = await fetch("/api/sessions/status");
  if (!response.ok) throw new Error("Unable to load session status.");
  return ((await response.json()) as { sessions: SessionStatus[] }).sessions;
};

/**
 * Add sessions the poll knows about and the server render did not.
 *
 * Ordered by timestamp rather than simply prepended: a newly created session is
 * usually the newest, but one that appeared in another tab need not be, and a
 * list that is nearly sorted is worse than one that is.
 */
export function mergeDiscoveredSessions(
  rendered: SessionRow[],
  status: SessionStatus[],
  removed: ReadonlySet<string> = new Set(),
): SessionRow[] {
  const known = new Set(rendered.map((session) => session.id));
  const discovered = status
    // `removed` is what keeps a deletion from undoing itself: the row leaves the
    // rendered list immediately, and until the poll catches up the status still
    // lists it — which would otherwise read as "add it back".
    .filter((session) => !known.has(session.id) && !removed.has(session.id))
    .map((session) => ({
      id: session.id,
      createdAt: session.createdAt,
      date: formatSessionDate(session.createdAt),
      isRunning: session.isRunning,
      title: session.title,
    }));

  if (discovered.length === 0) return rendered;

  // Rows without a timestamp keep the server's ordering by sorting as newest,
  // which is the order they arrived in.
  const at = (session: SessionRow) => session.createdAt ?? "9999";
  return [...discovered, ...rendered].sort((a, b) => at(b).localeCompare(at(a)));
}

export function SessionsListClient({ sessions }: { sessions: SessionRow[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const queryClient = useQueryClient();

  const [deleted, setDeleted] = useState<ReadonlySet<string>>(() => new Set());

  const [optimistic, removeOptimistically] = useOptimistic(
    sessions,
    (current, deletedId: string) => current.filter((s) => s.id !== deletedId),
  );

  // Polled from disk rather than pushed over Realtime: is_running lives in the
  // session record now, so the sidebar follows it without a database.
  const { data: status } = useQuery({
    queryKey: SESSION_STATUS_KEY,
    queryFn: fetchStatus,
    // Quick while something is running, because that is when it changes;
    // otherwise slow enough to be free. Paused automatically in a background
    // tab, where nobody is watching a spinner.
    refetchInterval: (query) =>
      (query.state.data ?? []).some((s) => s.isRunning) ? 2_000 : 15_000,
  });

  const statusById = new Map((status ?? []).map((s) => [s.id, s]));

  // The sidebar is a server component in a layout, and layouts persist across
  // client navigation — so a session created on the way to its own page was not
  // in `sessions` and did not appear until a server re-render happened to be
  // triggered. Anything the poll knows about and the server render did not is
  // added here, newest first, so it shows up as soon as it exists.
  const rows = mergeDiscoveredSessions(optimistic, status ?? [], deleted);

  const handleDelete = (id: string) => {
    // Held for the life of the page: an optimistic removal lasts only as long
    // as the transition, while the poll keeps returning the session until its
    // own refetch lands.
    setDeleted((current) => new Set(current).add(id));

    startTransition(async () => {
      removeOptimistically(id);
      await fetch(`/api/sessions/${id}`, { method: "DELETE" });
      await queryClient.invalidateQueries({ queryKey: SESSION_STATUS_KEY });
      router.refresh();
      if (pathname === `/sessions/${id}`) {
        router.push("/");
      }
    });
  };

  return (
    <ItemGroup className="max-w-sm">
      {rows.map((s) => (
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
