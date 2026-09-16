/**
 * Build (or refresh) the wiki's embedding sidecar.
 *
 * `@zosmaai/pi-llm-wiki` embeds pages at write time, so a vault that accumulated
 * its pages before a provider was configured has no vectors at all and recall
 * stays lexical no matter what the settings say. This is the one-off backfill,
 * and is safe to re-run: `isStale` skips any page whose content hash and model
 * already match, and the pass prunes entries for pages that were deleted.
 *
 * It deliberately drives the real resolution path — `isolatePiAgentDir`, then
 * Semla's `configureWikiEmbeddings`, then the package's own `loadTaskConfig` and
 * `resolveEmbedder` — rather than constructing an embedder from literals. A
 * script that reimplemented the config would pass while the harness stayed
 * lexical, which is the exact failure this is here to end.
 *
 * jiti because the package publishes TypeScript and is loaded from source
 * (WIKI_EXTENSION_PATH points at `extensions/llm-wiki/index.ts`), and with the
 * `@/` alias so importing Semla's own modules needs no second copy of them.
 *
 * Usage:
 *   node scripts/reindex-wiki-embeddings.mjs
 *   node scripts/reindex-wiki-embeddings.mjs --force   # re-embed everything
 */

import { join } from "node:path";
import { createJiti } from "jiti";

const force = process.argv.includes("--force");
const root = process.cwd();

const jiti = createJiti(import.meta.url, {
  alias: { "@": join(root, "src") },
  interopDefault: true,
});

const PACKAGE = "@zosmaai/pi-llm-wiki/extensions/llm-wiki/lib";

const { isolatePiAgentDir } = await jiti.import("@/lib/pi/runtime/agent-dir");
const { dir: agentDir } = isolatePiAgentDir();

const { configureWikiEmbeddings, describeWikiEmbeddings } = await jiti.import(
  "@/lib/pi/wiki/wiki-embedding-config",
);
const setup = configureWikiEmbeddings();
console.log(describeWikiEmbeddings(setup));
if (!setup.configured) process.exit(1);

const { WIKI_HOME } = await jiti.import("@/lib/pi/runtime/runtime-config");

const { loadTaskConfig } = await jiti.import(join(root, "node_modules", PACKAGE, "task-config.ts"));
const { resolveEmbedder, reindexEmbeddings } = await jiti.import(
  join(root, "node_modules", PACKAGE, "embeddings.ts"),
);
const { getVaultPaths } = await jiti.import(join(root, "node_modules", PACKAGE, "utils.ts"));

const config = loadTaskConfig(WIKI_HOME);
const embedder = resolveEmbedder(config);
if (!embedder) {
  console.error(
    `The package resolved no embedder from ${join(agentDir, "settings.json")}. ` +
      "Semla wrote the section, so this is the package disagreeing with it, not a missing file.",
  );
  process.exit(1);
}

const paths = getVaultPaths(WIKI_HOME);
console.log(`Vault:  ${WIKI_HOME}`);
console.log(`Model:  ${embedder.model}`);
console.log(`Mode:   ${force ? "force (re-embed every page)" : "stale only"}\n`);

const started = Date.now();
const stats = await reindexEmbeddings(paths, embedder, { force });
const seconds = ((Date.now() - started) / 1000).toFixed(1);

console.log(`Done in ${seconds}s: ${JSON.stringify(stats)}`);
