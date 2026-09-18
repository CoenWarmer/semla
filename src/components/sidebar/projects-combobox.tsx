"use client";

import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState, type ReactElement } from "react";

import type { WorkspaceProject } from "@/lib/pi/workspace/workspace";
import {
  readLastSelectedProject,
  writeLastSelectedProject,
} from "@/lib/last-selected-project";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ChatDotsIcon } from "@phosphor-icons/react";

export function ProjectsCombobox({ small }: { small?: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  // Read once per mount rather than on every render: the value only ever
  // changes as a result of this component's own handleSelect, at which point
  // the popover has already closed.
  const [lastSelected] = useState(readLastSelectedProject);

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
    writeLastSelectedProject(project.name);
    router.push(`/sessions/new?project=${encodeURIComponent(project.name)}`);
  }

  /**
   * Selecting straight from the "Recent" row, which only ever carries a name
   * (that is all localStorage holds). The fetched list is the source of truth
   * for what else the project record needs, so the recent row still routes
   * through the full project object once the list has loaded; before that it
   * falls back to navigating on the name alone, since that is all the
   * destination route needs.
   */
  function handleSelectRecent(name: string) {
    const match = projects?.find((project) => project.name === name);
    if (match) {
      handleSelect(match);
      return;
    }
    setOpen(false);
    router.push(`/sessions/new?project=${encodeURIComponent(name)}`);
  }

  const trigger = small
    ? {
        element: <Button variant="ghost" size="icon-sm"/>,
        label: <ChatDotsIcon />,
      }
    : {
        element: (
          <Button
            className="w-full justify-start font-normal text-muted-foreground"
            variant="outline"
          />
        ),
        label: "Select project…",
      };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={trigger.element}>{trigger.label}</PopoverTrigger>
      <PopoverContent className="w-64 p-0" side="right" sideOffset={8}>
        <Command>
          <CommandInput placeholder="Search projects…" />
          <CommandList>
            <CommandEmpty>No projects found.</CommandEmpty>
            {lastSelected && (
              <CommandGroup heading="Recent">
                <CommandItem
                  key={`recent-${lastSelected}`}
                  value={`recent ${lastSelected}`}
                  onSelect={() => handleSelectRecent(lastSelected)}
                >
                  {lastSelected}
                </CommandItem>
              </CommandGroup>
            )}
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
