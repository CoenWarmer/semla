"use client";

import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { FolderOpenIcon } from "lucide-react";
import { useParams } from "next/navigation";
import { useState } from "react";
import { SessionFilesPanel } from "./session-files-panel";

export function HeaderActions() {
  const params = useParams();
  const sessionId = typeof params?.id === "string" ? params.id : null;
  const [filesOpen, setFilesOpen] = useState(false);

  if (!sessionId) return null;

  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setFilesOpen(true)}>
        <FolderOpenIcon />
        Files
      </Button>

      <Sheet open={filesOpen} onOpenChange={setFilesOpen}>
        <SheetContent
          className="flex flex-col gap-0 p-0 sm:max-w-2xl"
          side="right"
        >
          <SheetHeader className="shrink-0 border-b px-6 py-4">
            <SheetTitle>Files</SheetTitle>
          </SheetHeader>
          <div className="min-h-0 flex-1">
            <SessionFilesPanel sessionId={sessionId} />
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
