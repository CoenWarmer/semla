import { useQuery } from "@tanstack/react-query";

// Type-only: mcp-config.ts pulls in node:fs, which must never reach the
// client bundle, but a type import is erased at compile time and leaves no
// runtime trace — so the response shape stays the one source of truth
// (McpConfigSummary) instead of a second copy that could drift from it.
import type { McpConfigSummary } from "@/lib/pi/mcp-config";

export type McpStatus = McpConfigSummary;

export const mcpStatusQueryKey = ["mcp-status"] as const;

const fetchMcpStatus = async (): Promise<McpStatus> => {
  const response = await fetch("/api/mcp/status");

  if (!response.ok) {
    throw new Error("Unable to load MCP server status.");
  }

  return (await response.json()) as McpStatus;
};

/**
 * The servers configured in Semla's pinned mcp.json, for the prompt bar.
 *
 * Not session-scoped like useTools — the config file is one per server
 * process, not one per session — so a single cache entry is correct
 * regardless of which session is open. staleTime matches useModels: cheap to
 * refetch, and short enough that editing mcp.json by hand while Semla is
 * running is reflected without a reload.
 */
export const useMcpStatus = () =>
  useQuery({
    queryFn: fetchMcpStatus,
    queryKey: mcpStatusQueryKey,
    staleTime: 30_000,
  });
