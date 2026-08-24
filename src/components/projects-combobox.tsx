"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import type { WorkspaceProject } from "@/lib/pi/workspace";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

export function ProjectsCombobox() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [projects, setProjects] = useState<WorkspaceProject[]>([]);
  const [navigating, setNavigating] = useState(false);

  useEffect(() => {
    fetch("/api/projects")
      .then((r) => r.json())
      .then((data: WorkspaceProject[]) => setProjects(data))
      .catch(() => {});
  }, []);

  async function handleSelect(project: WorkspaceProject) {
    setOpen(false);
    setNavigating(true);
    try {
      const res = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: project.name }),
      });
      const body = await res.json().catch(() => null);
      if (res.ok && body?.id) {
        router.push(
          `/sessions/${body.id}?project=${encodeURIComponent(project.name)}`,
        );
      }
    } finally {
      setNavigating(false);
    }
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            className="w-full justify-start font-normal text-muted-foreground"
            disabled={navigating}
            variant="outline"
          />
        }
      >
        {navigating ? "Opening…" : "Open project…"}
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" side="right" sideOffset={8}>
        <Command>
          <CommandInput placeholder="Search projects…" />
          <CommandList>
            <CommandEmpty>No projects found.</CommandEmpty>
            <CommandGroup>
              {projects.map((project) => (
                <CommandItem
                  key={project.path}
                  value={project.name}
                  onSelect={() => handleSelect(project)}
                >
                  {project.name}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
