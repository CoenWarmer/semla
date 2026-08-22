import { PI_WORKSPACE_ROOT } from "@/lib/pi/runtime-config";
import {
  DefaultPackageManager,
  getAgentDir,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

type PiPackage = {
  filtered: boolean;
  installed: boolean;
  scope: "project" | "user";
  source: string;
};

export function getInstalledPiPackages(): PiPackage[] {
  try {
    const agentDir = getAgentDir();
    const settingsManager = SettingsManager.create(
      PI_WORKSPACE_ROOT,
      agentDir,
      { projectTrusted: true },
    );
    const packageManager = new DefaultPackageManager({
      agentDir,
      cwd: PI_WORKSPACE_ROOT,
      settingsManager,
    });

    return packageManager
      .listConfiguredPackages()
      .map((piPackage) => ({
        filtered: piPackage.filtered,
        installed: Boolean(piPackage.installedPath),
        scope: piPackage.scope,
        source: piPackage.source,
      }))
      .sort((left, right) => left.source.localeCompare(right.source));
  } catch {
    return [];
  }
}
