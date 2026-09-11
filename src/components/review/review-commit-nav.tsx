"use client";

import { cn } from "@/lib/utils";
import type { TurnCommit } from "@/lib/review-types";

export function ReviewCommitNav({
  commits,
  selectedSha,
  onSelect,
}: {
  commits: TurnCommit[];
  selectedSha: string | null;
  onSelect: (sha: string | null) => void;
}) {
  if (commits.length === 0) return null;

  const selected = commits.find((c) => c.sha === selectedSha) ?? null;

  return (
    <div className="flex items-center flex-col">
      <div className="flex items-center gap-1 mb-1">
        {commits.map((commit) => (
          <div key={commit.sha}>
            <button
              key={commit.sha}
              type="button"
              title={`${commit.shortSha} ${commit.subject}`}
              aria-label={commit.subject}
              aria-pressed={commit.sha === selectedSha}
              onClick={() =>
                onSelect(commit.sha === selectedSha ? null : commit.sha)
              }
              className={cn(
                "size-2 rounded-full transition-colors",
                commit.sha === selectedSha
                  ? "bg-foreground"
                  : "bg-muted-foreground/40 hover:bg-muted-foreground/70",
              )}
            />
          </div>
        ))}
      </div>
      {selected ? (
        <div className="flex items-center min-w-max">
          <span className="flex text-xs gap-1">
            <span className="font-mono text-muted-foreground">
              #{selected.shortSha}
            </span>
            {selected.subject}
          </span>
        </div>
      ) : null}
    </div>
  );
}
