"use client";

import { Button } from "@/components/ui/button";
import { PlusIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

export function NewSessionButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function handleClick() {
    setLoading(true);
    try {
      const res = await fetch("/api/sessions", { method: "POST" });
      const body = await res.json();
      if (!res.ok || !body.id) {
        console.error("Failed to create session:", body);
        return;
      }
      router.push(`/sessions/${body.id}`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Button
      disabled={loading}
      onClick={handleClick}
      size="icon"
      variant="ghost"
    >
      <PlusIcon />
    </Button>
  );
}
