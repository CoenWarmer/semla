"use client";

import { useQuery } from "@tanstack/react-query";
import { PlusIcon } from "lucide-react";
import { useState } from "react";

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
import { useSessionProjectMutation } from "@/hooks/use-session-projects";
import type { WorkspaceProject } from "@/lib/pi/workspace";
import { cn } from "@/lib/utils";

/**
 * Attach another project to the session.
 *
 * Sits beside the badges in the header, so adding a project happens where the
 * projects already are. Kept out of the way until the header is hovered: it is
 * an occasional action next to indicators that are read constantly, and a
 * permanently visible control would compete with them.
 *
 * Reveals on focus as well as hover, so it is reachable without a pointer.
 */
export function SessionProjectPicker({
  className,
  linkedPaths,
  sessionId,
}: {
  className?: string;
  /** Already attached, and so not offered again. */
  linkedPaths: ReadonlySet<string>;
  sessionId: string;
}) {
  const [open, setOpen] = useState(false);
  const attach = useSessionProjectMutation(sessionId);

  // Only once the picker opens: this mounts on every session page, and the
  // workspace listing is a filesystem sweep nobody has asked to see yet.
  const { data: workspace } = useQuery<WorkspaceProject[]>({
    enabled: open,
    queryKey: ["workspace-projects"],
    queryFn: async () => {
      const res = await fetch("/api/projects");
      if (!res.ok) throw new Error("Unable to load workspace projects");
      return res.json() as Promise<WorkspaceProject[]>;
    },
  });

  const attachable = (workspace ?? []).filter(
    (project) => !linkedPaths.has(project.name),
  );

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger
        render={
          <button
            aria-label="Add a project to this session"
            className={cn(
              "flex size-6 items-center justify-center rounded text-muted-foreground transition-opacity hover:bg-accent hover:text-foreground",
              // Hidden until the header is hovered or this is focused. Stays
              // visible while its own popover is open, so it does not vanish
              // from under the pointer on the way to the list.
              open
                ? "opacity-100"
                : "opacity-0 focus-visible:opacity-100 group-hover/header:opacity-100",
              className,
            )}
            type="button"
          />
        }
      >
        <PlusIcon className="size-3.5" />
      </PopoverTrigger>
      <PopoverContent align="center" className="w-64 p-0" side="bottom">
        <Command>
          <CommandInput placeholder="Add a project…" />
          <CommandList>
            <CommandEmpty>No projects left to add.</CommandEmpty>
            <CommandGroup>
              {attachable.map((project) => (
                <CommandItem
                  key={project.path}
                  onSelect={() => {
                    setOpen(false);
                    attach.mutate({ kind: "attach", path: project.name });
                  }}
                  value={project.name}
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
