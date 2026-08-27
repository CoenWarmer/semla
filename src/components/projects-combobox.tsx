"use client";

import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";

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
  const [navigating, setNavigating] = useState(false);

  // Only fetched once the popover opens: the list is rendered nowhere else, and
  // this component sits in the sidebar on every page, so fetching on mount put
  // a request on the critical path of every page load for data nobody had asked
  // to see. React Query also dedupes it — the previous raw fetch in an effect
  // ran twice per mount under StrictMode.
  const { data: projects } = useQuery<WorkspaceProject[]>({
    enabled: open,
    queryFn: async () => {
      const response = await fetch("/api/projects");
      if (!response.ok) throw new Error("Unable to load projects.");
      return response.json() as Promise<WorkspaceProject[]>;
    },
    queryKey: ["workspace-projects"],
  });

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
              {(projects ?? []).map((project) => (
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
