"use client";

import { Button } from "@/components/ui/button";
import { PlusIcon } from "lucide-react";
import { useRouter } from "next/navigation";

export function NewSessionButton() {
  const router = useRouter();

  return (
    <Button
      onClick={() => router.push("/sessions/new")}
      size="icon"
      variant="ghost"
    >
      <PlusIcon />
    </Button>
  );
}
