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

  const { isolatePiAgentDir } = await import("@/lib/pi/agent-dir");
  const { dir, seeded } = isolatePiAgentDir();

  if (seeded.length > 0) {
    console.log(
      `[pi] seeded agent dir ${dir} from the host: ${seeded.join(", ")}. ` +
        "Semla no longer follows changes made with the pi CLI.",
    );
  }

  // Code intelligence resolves language servers by name on PATH, and degrades
  // quietly to structural evidence when one is missing. Do it before any session
  // starts, and say what it found, so a thin code answer is traceable to here.
  const { describeLanguageServers, ensureLanguageServersOnPath } = await import(
    "@/lib/pi/language-servers"
  );
  const languageServers = ensureLanguageServersOnPath();
  const languageServerLine = describeLanguageServers(languageServers);
  if (languageServers.missing.length > 0) console.warn(languageServerLine);
  else console.log(languageServerLine);

  // A vault inside the workspace outranks WIKI_HOME, so orient would quietly
  // write somewhere else. Reported at boot rather than discovered later from
  // pages that went missing.
  const { PI_WORKSPACE_ROOT, WIKI_HOME } = await import("@/lib/pi/runtime-config");
  const { describeShadowingVaults, findShadowingVaults } = await import(
    "@/lib/pi/wiki-vault-location"
  );
  const shadowing = findShadowingVaults(PI_WORKSPACE_ROOT, WIKI_HOME);
  if (shadowing.length > 0) {
    console.warn(describeShadowingVaults(shadowing, WIKI_HOME));
  }

  // The seeded catalog is a snapshot; refresh it once now so new provider
  // models show up, rather than on every ModelRuntime.create.
  const { refreshModelCatalog } = await import("@/lib/pi/model-catalog");
  const catalog = await refreshModelCatalog();
  console.log(
    catalog.refreshed
      ? `[pi] model catalog refreshed: ${catalog.models} models`
      : `[pi] model catalog refresh failed (${catalog.error}); using the catalog on disk`,
  );
}
