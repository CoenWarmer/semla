/**
 * Runs once before the server accepts requests.
 *
 * Semla's pi agent directory has to be set here rather than from a module its
 * consumers happen to import: `getAgentDir()` reads the environment at call
 * time, and /api/models, /api/sessions/[id]/messages and the context-check
 * route each build a ModelRuntime without importing runtime-config. A cold
 * start that landed on any of them would resolve the host's directory instead.
 */
export async function register() {
  // Also invoked for the edge runtime, which has no filesystem.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { isolatePiAgentDir } = await import("@/lib/pi/runtime/agent-dir");
  const { dir, seeded } = isolatePiAgentDir();

  if (seeded.length > 0) {
    console.log(
      `[pi] seeded agent dir ${dir} from the host: ${seeded.join(", ")}. ` +
        "Semla no longer follows changes made with the pi CLI.",
    );
  }

  // Pins pi-mcp-adapter to the one file inside `dir` above, rather than the
  // six-source precedence chain it otherwise merges — two of which are
  // host-global and would outrank anything set here. See mcp-config.ts.
  const { isolateMcpConfigMode } = await import("@/lib/pi/runtime/mcp-config");
  const mcpConfig = isolateMcpConfigMode();
  console.log(`[pi] mcp config mode: ${mcpConfig.mode} (${mcpConfig.path})`);

  // Code intelligence resolves language servers by name on PATH, and degrades
  // quietly to structural evidence when one is missing. Do it before any session
  // starts, and say what it found, so a thin code answer is traceable to here.
  const { describeLanguageServers, ensureLanguageServersOnPath } = await import(
    "@/lib/pi/runtime/language-servers"
  );
  const languageServers = ensureLanguageServersOnPath();
  const languageServerLine = describeLanguageServers(languageServers);
  if (languageServers.missing.length > 0) console.warn(languageServerLine);
  else console.log(languageServerLine);

  // A vault inside the workspace outranks WIKI_HOME, so orient would quietly
  // write somewhere else. Reported at boot rather than discovered later from
  // pages that went missing.
  const { PI_WORKSPACE_ROOT, WIKI_HOME } = await import("@/lib/pi/runtime/runtime-config");
  const { describeShadowingVaults, findShadowingVaults } = await import(
    "@/lib/pi/wiki/wiki-vault-location"
  );
  const shadowing = findShadowingVaults(PI_WORKSPACE_ROOT, WIKI_HOME);
  if (shadowing.length > 0) {
    console.warn(describeShadowingVaults(shadowing, WIKI_HOME));
  }

  // The wiki's embedding path is dormant unless a provider is configured, and
  // says nothing when it is not — every recall silently falls back to lexical
  // substring matching. Wired here, before any session can recall, and logged
  // either way so the ranking in use is never a guess.
  const { configureWikiEmbeddings, describeWikiEmbeddings } = await import(
    "@/lib/pi/wiki/wiki-embedding-config"
  );
  const embeddings = configureWikiEmbeddings();
  if (embeddings.configured) console.log(describeWikiEmbeddings(embeddings));
  else console.warn(describeWikiEmbeddings(embeddings));

  // The seeded catalog is a snapshot; refresh it once now so new provider
  // models show up, rather than on every ModelRuntime.create.
  const { refreshModelCatalog } = await import("@/lib/pi/runtime/model-catalog");
  const catalog = await refreshModelCatalog();
  console.log(
    catalog.refreshed
      ? `[pi] model catalog refreshed: ${catalog.models} models`
      : `[pi] model catalog refresh failed (${catalog.error}); using the catalog on disk`,
  );
}
