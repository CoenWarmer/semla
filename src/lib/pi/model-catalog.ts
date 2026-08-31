/**
 * Refresh the model catalog once, at server start.
 *
 * Now that credentials and the catalog live in Semla's own agent directory
 * (see agent-dir.ts), models-store.json is a snapshot taken when that directory
 * was seeded. Left alone it goes stale: a provider adds a model and Semla never
 * offers it.
 *
 * `refreshOnCreate` alone does not fix that. ModelRuntime.create gates the
 * network on a separate flag:
 *
 *     const refreshFromNetwork =
 *       runtime.modelNetworkEnabled && options.allowModelNetwork === true;
 *
 * so `refreshOnCreate: true` on its own only reloads models.json and rebuilds
 * the provider list from what is already on disk. Fetching needs
 * allowModelNetwork, and doing that per create would put a network round trip
 * in front of every session start, every /api/models call and every
 * context-check — which is presumably why every call site passes
 * `refreshOnCreate: false` today.
 *
 * Once per boot gives freshness without that cost. It is deliberately
 * best-effort: a slow or offline network must not hold up the server, and the
 * seeded snapshot is a perfectly good fallback. PI_OFFLINE is honoured by the
 * runtime itself, which leaves modelNetworkEnabled false.
 */

import { ModelRuntime } from "@earendil-works/pi-coding-agent";

/** Long enough for a normal fetch, short enough not to stall a restart. */
const DEFAULT_TIMEOUT_MS = 8_000;

type CreateRuntime = typeof ModelRuntime.create;

export interface CatalogRefresh {
  refreshed: boolean;
  models: number;
  error?: string;
}

export async function refreshModelCatalog(
  options: { timeoutMs?: number; create?: CreateRuntime } = {},
): Promise<CatalogRefresh> {
  const create = options.create ?? ModelRuntime.create.bind(ModelRuntime);

  try {
    const runtime = await create({
      refreshOnCreate: true,
      allowModelNetwork: true,
      modelRefreshTimeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    const models = await runtime.getAvailable();
    return { refreshed: true, models: models.length };
  } catch (error) {
    // The seeded catalog still works, so this is worth reporting and not worth
    // failing a boot over.
    return {
      refreshed: false,
      models: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
