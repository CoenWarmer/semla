"use client";

import { cn } from "@/lib/utils";
import type { TurnCommit } from "@/lib/review/review-types";

/**
 * The turn's commits as dots, plus one for the working tree.
 *
 * The trailing dot is not a new state. `selectedSha === null` has always meant
 * "show the working copy", and it was reachable only by clicking the selected
 * commit again — so the default state had no handle. The dot gives it one, and
 * being the state a panel opens in, it is the one that is active before the
 * operator touches anything.
 *
 * Reading order is left-to-right oldest-first, which is why `commits` is
 * reversed here: `readTurnCommits` returns newest first (git log's order), and
 * a row of dots that runs backwards while the working tree sits at the end
 * would put "now" at both ends.
 */
export function ReviewCommitNav({
  commits,
  selectedSha,
  onSelect,
}: {
  commits: TurnCommit[];
  /** null means the working tree — the trailing dot. */
  selectedSha: string | null;
  onSelect: (sha: string | null) => void;
}) {
  if (commits.length === 0) return null;

  const selected = commits.find((c) => c.sha === selectedSha) ?? null;
  const oldestFirst = [...commits].reverse();

  return (
    <div className="flex items-center flex-col w-full">
      <div className="flex items-center gap-1 mb-1">
        {oldestFirst.map((commit, index) => (
          <button
            aria-label={commit.subject}
            aria-pressed={commit.sha === selectedSha}
            className={cn(
              "size-2 rounded-full transition-colors",
              commit.sha === selectedSha
                ? "bg-foreground"
                : "bg-muted-foreground/40 hover:bg-muted-foreground/70",
              index > 0 ? "ml-1.5" : "",
            )}
            key={commit.sha}
            onClick={() =>
              onSelect(commit.sha === selectedSha ? null : commit.sha)
            }
            title={`${commit.shortSha} ${commit.subject}`}
            type="button"
          />
        ))}

        {/* Hollow rather than filled, so it reads as "not yet a commit" —
            which is exactly what uncommitted work is. */}
        <button
          aria-label="Uncommitted changes"
          aria-pressed={selectedSha === null}
          className={cn(
            "size-2 p-1 rounded-full border transition-colors ml-1.5",
            selectedSha === null
              ? "border-foreground bg-foreground/30"
              : "border-muted-foreground/40 hover:border-muted-foreground/70",
          )}
          onClick={() => onSelect(null)}
          title="Uncommitted and unstaged changes"
          type="button"
        />
      </div>

      {selected ? (
        <div className="flex items-center mt-1">
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
