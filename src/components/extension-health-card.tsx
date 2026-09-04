import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { getExtensionHealth } from "@/lib/pi/extension-health";

/**
 * A broken Pi extension used to be visible only in the server log, while the
 * symptom the user saw was "the agent has no wiki tools". This shows the
 * declared extension set alongside how it actually loaded in the last session.
 */
export async function ExtensionHealthCard() {
  const health = await getExtensionHealth();
  // Keyed by string: ExtensionHealth widens the manifest id for serialisation.
  const statusById = new Map(
    (health.lastLoad?.extensions ?? []).map(
      (status) => [status.id as string, status] as const,
    ),
  );

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <CardTitle>Pi extensions</CardTitle>
            <CardDescription>
              Loaded in dependency order on every session.
              {health.lastLoad
                ? " Status is from the most recent session."
                : " No session has run yet in this server process."}
            </CardDescription>
          </div>
          <Badge variant={health.ok ? "secondary" : "destructive"}>
            {health.ok ? "Healthy" : "Degraded"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <ul className="divide-y">
          {health.manifest.map((extension) => {
            const status = statusById.get(extension.id);
            const problems = [
              ...(status && !status.loaded ? ["did not load"] : []),
              ...(status?.error ? [status.error] : []),
              ...(status?.missingTools.length
                ? [`missing ${status.missingTools.join(", ")}`]
                : []),
              ...(status?.missingSlots.length
                ? [`missing slot ${status.missingSlots.join(", ")}`]
                : []),
            ];

            return (
              <li
                className="flex items-start justify-between gap-4 py-3 first:pt-0 last:pb-0"
                key={extension.id}
              >
                <div className="min-w-0 space-y-1">
                  <code className="block truncate text-sm">{extension.id}</code>
                  <p className="text-xs text-muted-foreground">
                    {extension.providesTools.length > 0
                      ? `${extension.providesTools.length} tool${extension.providesTools.length === 1 ? "" : "s"}`
                      : "no tools"}
                    {extension.providesSlots.length > 0
                      ? ` · ${extension.providesSlots.length} contract slot${extension.providesSlots.length === 1 ? "" : "s"}`
                      : ""}
                    {status?.optionalToolsPresent.length
                      ? ` · ${status.optionalToolsPresent.length} gated tool${status.optionalToolsPresent.length === 1 ? "" : "s"} enabled`
                      : ""}
                  </p>
                  {problems.length > 0 ? (
                    <p className="text-xs text-destructive">
                      {problems.join(" · ")}
                    </p>
                  ) : null}
                </div>
                <Badge
                  variant={
                    !status
                      ? "outline"
                      : problems.length === 0
                        ? "secondary"
                        : "destructive"
                  }
                >
                  {!status
                    ? "Not observed"
                    : problems.length === 0
                      ? "OK"
                      : "Failed"}
                </Badge>
              </li>
            );
          })}
        </ul>

        {health.installation.problems.length > 0 ? (
          <div className="space-y-1 rounded-md border border-destructive/40 p-3">
            <p className="text-sm font-medium text-destructive">
              Installation problems
            </p>
            {health.installation.problems.map((problem) => (
              <p className="text-xs text-muted-foreground" key={problem}>
                {problem}
              </p>
            ))}
          </div>
        ) : null}

        {health.lastLoad?.unexpectedErrors.length ? (
          <div className="space-y-1 rounded-md border p-3">
            <p className="text-sm font-medium">Other extension errors</p>
            <p className="text-xs text-muted-foreground">
              Loaded from outside Semla&apos;s manifest, so they do not block a
              session.
            </p>
            {health.lastLoad.unexpectedErrors.map((error) => (
              <p className="break-all text-xs text-muted-foreground" key={error}>
                {error}
              </p>
            ))}
          </div>
        ) : null}

        {health.mcp ? (
          <div className="space-y-1 rounded-md border p-3">
            <div className="flex items-start justify-between gap-4">
              <p className="text-sm font-medium">MCP servers</p>
              <Badge
                variant={
                  health.mcp.error
                    ? "destructive"
                    : health.mcp.enabledServers.length > 0
                      ? "secondary"
                      : "outline"
                }
              >
                {health.mcp.error
                  ? "Unreadable"
                  : health.mcp.enabledServers.length > 0
                    ? `${health.mcp.enabledServers.length} configured`
                    : "None configured"}
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground">
              Read from{" "}
              <code className="break-all">{health.mcp.configPath}</code>
              {health.mcp.error
                ? " \u2014 does not parse."
                : health.mcp.enabledServers.length === 0
                  ? " \u2014 the gateway tool is registered but has nothing to reach."
                  : "."}
            </p>
            {health.mcp.error ? (
              <p className="text-xs text-destructive">{health.mcp.error}</p>
            ) : null}
            {health.mcp.enabledServers.length > 0 ? (
              <p className="text-xs text-muted-foreground">
                {health.mcp.enabledServers.join(", ")}
                {health.mcp.servers.length > health.mcp.enabledServers.length
                  ? ` (+${health.mcp.servers.length - health.mcp.enabledServers.length} disabled)`
                  : ""}
              </p>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
