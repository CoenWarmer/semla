"use client";

/**
 * The opt-in surface for the code index: every workspace project, whether it
 * has an index, and a button to build or drop one.
 *
 * Progress arrives over SSE rather than polling. An ingest emits a phase change
 * per file and then sits inside one embedding call for seconds, so a poll fast
 * enough to show chunking spends most of its requests learning nothing, and a
 * slow one shows a bar that jumps from nothing to done. The stream is read with
 * the same `fetch` + `getReader()` loop the terminal and session streams use.
 *
 * One connection covers every project, so a run started in another tab shows up
 * here without a refresh.
 */

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  codeIndexQueryKey,
  useCodeIndexAction,
  useCodeIndexStatus,
  type ProjectIndexStatus,
} from "@/hooks/use-code-index";

interface RunEvent {
  path: string;
  running: boolean;
  phase: string;
  done: number;
  total: number;
  tokens: number;
  cost: number;
  error: string | null;
  chunks: number | null;
}

export function CodeIndexPanel() {
  // Fetched through react-query rather than an effect: an effect that sets
  // state on mount is the cascading render the React Compiler rules reject, and
  // this page is already a query client.
  const { data: projects, error: loadError } = useCodeIndexStatus();
  const action = useCodeIndexAction();
  const queryClient = useQueryClient();

  const [runs, setRuns] = useState<Record<string, RunEvent>>({});

  useEffect(() => {
    const abort = new AbortController();
    let disposed = false;

    const run = async () => {
      const response = await fetch("/api/code-index/stream", { signal: abort.signal });
      if (!response.ok || !response.body) return;

      // The same framing the terminal stream uses, read the same way.
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (!disposed) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";

        for (const frame of frames) {
          const line = frame.split("\n").find((one) => one.startsWith("data: "));
          if (!line) continue;
          const event = JSON.parse(line.slice(6)) as RunEvent;
          setRuns((previous) => ({ ...previous, [event.path]: event }));
          // A finished run changed the stored head, which only the status
          // endpoint knows about.
          if (!event.running) {
            void queryClient.invalidateQueries({ queryKey: codeIndexQueryKey });
          }
        }
      }
    };

    run().catch((cause: unknown) => {
      if ((cause as Error)?.name === "AbortError") return;
      console.error("[code-index]", cause);
    });

    return () => {
      disposed = true;
      abort.abort();
    };
  }, [queryClient]);

  const error =
    action.error?.message ??
    (loadError !== null ? "Unable to load index status." : null);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Code index</CardTitle>
        <CardDescription>
          Semantic search over a project&apos;s source, for questions whose wording does
          not appear in the code. Indexing is per project and off until you ask for it:
          it sends chunk text to the embedding provider and costs roughly a cent per
          repository. Re-indexing is incremental — only changed files are re-embedded.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {error !== null && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}

        {projects === undefined && <p className="text-sm text-muted-foreground">Loading…</p>}
        {projects?.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No projects found under the workspace root.
          </p>
        )}

        {projects?.map((project: ProjectIndexStatus) => {
          const run = runs[project.path];
          const running = run?.running === true;

          return (
            <div
              key={project.path}
              className="flex items-center justify-between gap-4 rounded-md border p-3"
            >
              <div className="min-w-0 space-y-1">
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium">{project.name}</span>
                  {project.indexed ? (
                    <Badge variant="secondary">
                      {project.chunks?.toLocaleString()} chunks
                    </Badge>
                  ) : (
                    <Badge variant="outline">not indexed</Badge>
                  )}
                </div>

                <p className="truncate text-xs text-muted-foreground">{project.path}</p>

                {running && (
                  <p className="text-xs text-muted-foreground">
                    {run.phase}
                    {run.total > 0 ? ` ${run.done}/${run.total}` : ""}
                    {run.cost > 0 ? ` · $${run.cost.toFixed(4)}` : ""}
                  </p>
                )}

                {!running && run?.error != null && (
                  <p className="text-xs text-destructive">{run.error}</p>
                )}

                {!running && project.indexed && project.updated !== null && (
                  <p className="text-xs text-muted-foreground">
                    {project.model} · built {new Date(project.updated).toLocaleString()}
                  </p>
                )}
              </div>

              <div className="flex shrink-0 gap-2">
                <Button
                  size="sm"
                  variant={project.indexed ? "outline" : "default"}
                  disabled={running}
                  onClick={() => action.mutate({ path: project.path, method: "POST" })}
                >
                  {running ? "Indexing…" : project.indexed ? "Re-index" : "Index"}
                </Button>
                {project.indexed && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={running}
                    onClick={() => action.mutate({ path: project.path, method: "DELETE" })}
                  >
                    Drop
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
