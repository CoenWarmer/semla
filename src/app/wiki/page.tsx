import { Suspense } from "react";
import { WikiBrowser } from "@/components/wiki/wiki-browser";
import {
  computeWikiLinks,
  getWikiConfig,
  getWikiRegistry,
  isWikiInitialized,
} from "@/lib/wiki";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default function WikiPage() {
  if (!isWikiInitialized()) {
    return (
      <div className="flex h-full items-center justify-center p-10 text-sm text-muted-foreground">
        No wiki initialized. Run the orient skill in a session to get started.
      </div>
    );
  }

  const config = getWikiConfig();
  const registry = getWikiRegistry();
  const links = registry ? computeWikiLinks(registry) : [];

  const initialPath = registry
    ? (Object.keys(registry.pages)[0] ?? null)
    : null;

  return (
    <Suspense>
      <WikiBrowser
        config={config}
        registry={registry}
        links={links}
        initialPath={initialPath}
      />
    </Suspense>
  );
}
