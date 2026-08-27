"use client";

import { GitBranchIcon, SearchIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import type { WorkspaceProject } from "@/lib/pi/workspace";
import { Badge } from "@/components/ui/badge";
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
import { cn } from "@/lib/utils";

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

export function ProjectsGrid({ projects }: { projects: WorkspaceProject[] }) {
  const router = useRouter();
  const [navigating, setNavigating] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<SortKey>("staleness");

  async function openProject(project: WorkspaceProject) {
    if (navigating) return;
    setNavigating(project.path);
    try {
      const res = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: project.name, projectPath: project.path }),
      });
      const body = await res.json().catch(() => null);
      if (res.ok && body?.id) {
        router.push(
          `/sessions/${body.id}?project=${encodeURIComponent(project.name)}`,
        );
      }
    } finally {
      setNavigating(null);
    }
  }

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
          {visible.map((project) => {
            const isLoading = navigating === project.path;
            return (
              <Card
                key={project.path}
                className={cn(
                  "cursor-pointer transition-opacity hover:opacity-80",
                  isLoading && "pointer-events-none opacity-60",
                )}
                onClick={() => openProject(project)}
              >
                <CardHeader>
                  <CardTitle>{project.name}</CardTitle>
                  <CardDescription className="truncate font-mono text-xs">
                    {project.path}
                  </CardDescription>
                </CardHeader>
                <div className="flex items-center gap-2 px-6 pb-6">
                  {project.branch && (
                    <Badge variant="outline" className="gap-1 font-mono">
                      <GitBranchIcon className="size-3" />
                      {project.branch}
                    </Badge>
                  )}
                  <span className="text-xs text-muted-foreground">
                    {project.stalenessText}
                  </span>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
