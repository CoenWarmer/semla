"use client";

import { startTransition, useOptimistic } from "react";
import { usePathname, useRouter } from "next/navigation";
import { ItemGroup } from "@/components/ui/item";
import { SessionItem } from "@/components/session-item";

export type SessionRow = {
  id: string;
  date: string;
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
        <SessionItem key={s.id} {...s} onDelete={handleDelete} />
      ))}
    </ItemGroup>
  );
}
