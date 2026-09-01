"use client";

import { SearchIcon } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { GitStatusBadge } from "@/components/git-status-badge";
import type { WorkspaceProject } from "@/lib/pi/workspace";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type SortKey = "staleness" | "name-asc" | "name-desc";

function sortProjects(projects: WorkspaceProject[], sort: SortKey): WorkspaceProject[] {
  return [...projects].sort((a, b) => {
    if (sort === "name-asc") return a.name.localeCompare(b.name);
    if (sort === "name-desc") return b.name.localeCompare(a.name);
    // staleness: most recent first; null commits go last
    if (a.lastCommitAt === null && b.lastCommitAt === null) return 0;
    if (a.lastCommitAt === null) return 1;
    if (b.lastCommitAt === null) return -1;
    return b.lastCommitAt - a.lastCommitAt;
  });
}

/**
 * Where a card goes: a session that does not exist yet, carrying its project.
 *
 * A link rather than a click handler, so Next prefetches the route on hover and
 * the navigation is already paid for by the time the card is pressed. It used
 * to POST a session first and navigate once the id came back — half a second of
 * a card looking unresponsive, and an empty session written whether or not
 * anybody went on to type anything.
 */
export const newSessionHref = (projectName: string) =>
  `/sessions/new?project=${encodeURIComponent(projectName)}`;

export function ProjectsGrid({ projects }: { projects: WorkspaceProject[] }) {
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<SortKey>("staleness");

  if (projects.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No git repositories found in the workspace.
      </p>
    );
  }

  const query = filter.trim().toLowerCase();
  const visible = sortProjects(
    query ? projects.filter((p) => p.name.toLowerCase().includes(query)) : projects,
    sort,
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="relative flex-1">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-9"
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter projects…"
            value={filter}
          />
        </div>
        <Select onValueChange={(v) => setSort(v as SortKey)} value={sort}>
          <SelectTrigger className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="staleness">Recently active</SelectItem>
            <SelectItem value="name-asc">Name A → Z</SelectItem>
            <SelectItem value="name-desc">Name Z → A</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {visible.length === 0 ? (
        <p className="text-sm text-muted-foreground">No projects match &ldquo;{filter}&rdquo;.</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map((project) => (
            <Card
              key={project.path}
              className="relative transition-opacity hover:opacity-80"
            >
              {/*
                A stretched link rather than a link around the card: the badge
                below is interactive, and an anchor may not contain a button.
                This covers the card, and everything that is not the badge is
                inert so the click reaches it.
              */}
              <Link
                aria-label={`Start a session in ${project.name}`}
                className="absolute inset-0 rounded-[inherit]"
                href={newSessionHref(project.name)}
              >
                <span className="sr-only">Start a session in {project.name}</span>
              </Link>
              <CardHeader className="pointer-events-none relative">
                <CardTitle>{project.name}</CardTitle>
                <CardDescription className="truncate font-mono text-xs">
                  {project.path}
                </CardDescription>
              </CardHeader>
              <div className="pointer-events-none relative flex items-center gap-2 px-6 pb-6">
                {/* Supersedes the branch name this card used to print: same
                    branch, plus how far it has drifted, and the two actions
                    that follow from that. */}
                <span className="pointer-events-auto">
                  <GitStatusBadge
                    className="-mx-1"
                    target={{ kind: "project", path: project.path }}
                  />
                </span>
                <span className="text-xs text-muted-foreground">
                  {project.stalenessText}
                </span>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
