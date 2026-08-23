import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  getPiCredentialProviders,
  getPiRuntimeConfig,
} from "@/lib/pi/runtime-config";
import { getInstalledPiPackages } from "@/lib/pi/packages";
import { SystemPromptEditor } from "@/components/system-prompt-editor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const [packages, config, credentialProviders] = await Promise.all([
    Promise.resolve(getInstalledPiPackages()),
    Promise.resolve(getPiRuntimeConfig()),
    getPiCredentialProviders(),
  ]);

  const configuration = [
    ["Sandboxed runtime", config.sandboxed ? "Enabled" : "Disabled"],
    [
      "Local development bypass",
      config.hostDevelopmentEnabled ? "Enabled" : "Disabled",
    ],
    [
      "Pi credentials",
      credentialProviders.length > 0
        ? `Configured for ${credentialProviders.join(", ")}`
        : "Not configured",
    ],
    [
      "Runtime API-key override",
      config.apiKeyConfigured ? "Configured" : "Not configured",
    ],
    ["Workspace root", config.workspaceRoot],
    ["Temporary Pi session files", config.sessionDirectory],
    ["Persistent session storage", "Supabase"],
    ["Allowed tools", config.tools.join(", ")],
  ];

  return (
    <div className="mx-auto w-full max-w-5xl space-y-8 p-6 sm:p-10">
      <div className="space-y-2">
        <h1 className="font-heading text-3xl font-semibold">Settings</h1>
        <p className="text-muted-foreground">
          Runtime information for Semla&apos;s Pi agent loop.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>System prompt</CardTitle>
          <CardDescription>
            Instructions appended to pi&apos;s system prompt on every session. Defines how the orchestrator agent should approach tasks.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <SystemPromptEditor />
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Installed Pi packages</CardTitle>
            <CardDescription>
              Package sources configured for this Pi workspace and user.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {packages.length > 0 ? (
              <ul className="divide-y">
                {packages.map((piPackage) => (
                  <li
                    className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0"
                    key={`${piPackage.scope}:${piPackage.source}`}
                  >
                    <div className="min-w-0 space-y-1">
                      <code className="block truncate text-sm">
                        {piPackage.source}
                      </code>
                      <p className="text-xs text-muted-foreground">
                        {piPackage.scope} scope
                        {piPackage.filtered ? " · filtered resources" : ""}
                      </p>
                    </div>
                    <Badge
                      variant={
                        piPackage.installed ? "secondary" : "destructive"
                      }
                    >
                      {piPackage.installed ? "Installed" : "Not installed"}
                    </Badge>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">
                No Pi packages are configured for this workspace.
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Pi loop configuration</CardTitle>
            <CardDescription>
              The active execution and persistence settings.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="divide-y">
              {configuration.map(([label, value]) => (
                <div
                  className="flex items-start justify-between gap-6 py-3 first:pt-0 last:pb-0"
                  key={label}
                >
                  <dt className="text-sm text-muted-foreground">{label}</dt>
                  <dd className="max-w-[60%] break-all text-right font-mono text-sm">
                    {value}
                  </dd>
                </div>
              ))}
            </dl>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
