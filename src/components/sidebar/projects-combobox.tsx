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

  /**
   * The same destination the home page's project cards use: a session that does
   * not exist yet, carrying its project in the URL. Creating one here meant
   * waiting on a POST before the navigation could start, and writing an empty
   * session for a project picked by mistake.
   */
  function handleSelect(project: WorkspaceProject) {
    setOpen(false);
    router.push(`/sessions/new?project=${encodeURIComponent(project.name)}`);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            className="w-full justify-start font-normal text-muted-foreground"
            variant="outline"
          />
        }
      >
        Open project…
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
