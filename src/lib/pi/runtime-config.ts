import { ModelRuntime } from "@earendil-works/pi-coding-agent";

export const PI_WORKSPACE_ROOT = "/workspace";
export const PI_SESSION_DIR = "/tmp/semla-pi-sessions";
export const PI_TOOLS = ["read", "bash", "edit", "write"] as const;

export const getPiRuntimeConfig = () => ({
  apiKeyConfigured: Boolean(process.env.PI_MODEL_API_KEY),
  hostDevelopmentEnabled:
    process.env.NODE_ENV === "development" &&
    process.env.PI_ALLOW_HOST_DEV === "true",
  sandboxed: process.env.PI_SANDBOXED === "true",
  sessionDirectory: PI_SESSION_DIR,
  tools: PI_TOOLS,
  workspaceRoot: PI_WORKSPACE_ROOT,
});

export const getPiCredentialProviders = async (): Promise<string[]> => {
  try {
    const runtime = await ModelRuntime.create({ refreshOnCreate: false });
    const credentials = await runtime.listCredentials();

    return credentials
      .map((credential) => credential.providerId)
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
};
