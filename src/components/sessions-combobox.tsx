"use client";

import { ListMagnifyingGlassIcon } from "@phosphor-icons/react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { useSessions } from "@/hooks/use-sessions";
import { formatSessionDate } from "@/lib/session/session-date";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "./ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";

export function SessionsCombobox({ small }: { small?: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  // Only fetched once the popover opens, same reasoning as ProjectsCombobox:
  // this sits in the topbar on every session page, and nobody has asked to
  // see the list yet.
  const { data: sessions } = useSessions({ enabled: open });

  function handleSelect(id: string) {
    setOpen(false);
    router.push(`/sessions/${id}`);
  }

  const trigger = small
    ? {
        element: <Button size="icon-sm" variant="ghost" />,
        label: <ListMagnifyingGlassIcon />,
      }
    : {
        element: (
          <Button
            className="w-full justify-start font-normal text-muted-foreground"
            variant="outline"
          />
        ),
        label: "Search sessions…",
      };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={trigger.element}>{trigger.label}</PopoverTrigger>
      <PopoverContent className="w-64 p-0" side="bottom" sideOffset={8}>
        <Command>
          <CommandInput placeholder="Search sessions…" />
          <CommandList>
            <CommandEmpty>No sessions found.</CommandEmpty>
            <CommandGroup>
              {(sessions ?? []).map((session) => (
                <CommandItem
                  key={session.id}
                  onSelect={() => handleSelect(session.id)}
                  value={session.title ?? session.id}
                >
                  <span className="truncate">
                    {session.title ?? "Untitled session"}
                  </span>
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                    {formatSessionDate(session.createdAt)}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
