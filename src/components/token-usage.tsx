import { cn } from "@/lib/utils";

/**
 * The one place the app renders "how much did this consume". Session totals,
 * the global header badge, workflow runs, individual agents and the live stream
 * estimate all go through here, so a usage readout looks and rounds the same
 * everywhere it appears.
 *
 * No "use client" on purpose — it is pure presentation, so server components
 * (the agent detail page) can render it directly.
 */

/** Abbreviated token count: 812, 12.6k, 1.9M. */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toLocaleString();
}

/** Cost in dollars, keeping enough decimals to stay non-zero for cheap calls. */
export function formatCost(cost: number): string {
  if (cost < 0.001) return `$${cost.toFixed(5)}`;
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(3)}`;
}

type TokenUsageProps = {
  /** Marks the count as an estimate ("~1.2k tokens") rather than reported usage. */
  approximate?: boolean;
  className?: string;
  /** Dollar cost of those tokens. Omitted or 0 renders the count alone. */
  cost?: number | null;
  /** Rendered instead of nothing when there is no usage to show. */
  emptyLabel?: string;
  /** Hides the token count and shows cost only, for tight spots like the header. */
  costOnly?: boolean;
  /** Overrides the default tooltip, which spells out the exact figures. */
  title?: string;
  tokens?: number | null;
};

export function TokenUsage({
  approximate,
  className,
  cost,
  costOnly,
  emptyLabel,
  title,
  tokens,
}: TokenUsageProps) {
  const hasTokens = !costOnly && tokens != null && tokens > 0;
  const hasCost = cost != null && cost > 0;

  if (!hasTokens && !hasCost) {
    return emptyLabel ? <span className={className}>{emptyLabel}</span> : null;
  }

  const parts: string[] = [];
  if (hasTokens) {
    parts.push(`${approximate ? "~" : ""}${formatTokens(tokens)}`);
  }
  if (hasCost) parts.push(formatCost(cost));

  // The visible count is abbreviated, so the tooltip carries the exact numbers.
  const exact: string[] = [];
  if (tokens != null && tokens > 0) exact.push(`${tokens.toLocaleString()}`);
  if (hasCost) exact.push(`$${cost.toFixed(5)}`);

  return (
    <span
      className={cn("tabular-nums", className)}
      title={title ?? exact.join(" · ")}
    >
      {parts.join(" - ")}
    </span>
  );
}
