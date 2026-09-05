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
    <div className="flex items-center gap-2">
      <div className="flex items-center gap-1">
        {commits.map((commit, i) => (
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
        ))}
      </div>
      <span className="max-w-48 truncate text-xs text-muted-foreground">
        {selected
          ? `${selected.shortSha} ${selected.subject}`
          : `${commits.length} commit${commits.length === 1 ? "" : "s"}`}
      </span>
    </div>
  );
}
