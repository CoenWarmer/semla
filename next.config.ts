import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  reactCompiler: true,
  serverExternalPackages: [
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-coding-agent",
    // Native binding plus a helper binary it exec's by path. Bundling it would
    // both fail to resolve the .node and move the helper out from under it.
    "node-pty",
    // Exports a path to a binary, derived from its own __dirname. Bundling it
    // rewrites that and the path stops pointing at the executable — the same
    // failure as node-pty's helper, for the same reason.
    "@vscode/ripgrep",
  ],
};

export default nextConfig;
