"use client";

import { Button } from "@/components/ui/button";
import { PlusIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

export function NewSessionButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();

  async function handleClick() {
    setLoading(true);
    setError(undefined);
    try {
      const res = await fetch("/api/sessions", { method: "POST" });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.id) {
        console.error("Failed to create session:", body);
        setError("Could not create a new session. Please try again.");
        return;
      }
      router.push(`/sessions/${body.id}`);
      router.refresh();
    } catch (err) {
      console.error("Failed to create session:", err);
      setError("Could not create a new session. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        disabled={loading}
        onClick={handleClick}
        size="icon"
        variant="ghost"
      >
        <PlusIcon />
      </Button>
      {error ? (
        <span className="text-destructive text-xs">{error}</span>
      ) : null}
    </div>
  );
}
