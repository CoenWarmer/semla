/**
 * The one part of the composition that needs the pi runtime.
 *
 * The arithmetic lives in @/lib/context-composition, which the browser can run.
 * This is here because ModelRuntime imports child_process and fs at module
 * scope, and a client component that reached it would fail to compile the whole
 * page — see client-boundary.test.ts.
 */

import { ModelRuntime } from "@earendil-works/pi-coding-agent";

/** Context window of the model a session is configured to use. */
export async function modelContextWindow(
  provider: string | null | undefined,
  modelId: string | null | undefined,
): Promise<number | null> {
  if (!provider || !modelId) return null;
  try {
    // No refresh and no request: this only reads the catalog already on disk.
    const runtime = await ModelRuntime.create({ refreshOnCreate: false });
    return runtime.getModel(provider, modelId)?.contextWindow ?? null;
  } catch {
    return null;
  }
}
