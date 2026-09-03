"use client";

/**
 * The review editor, loaded only when it is needed.
 *
 * Monaco is several megabytes. Behind `next/dynamic` with `ssr: false` it
 * lands in its own chunk and a session that never opens the review panel never
 * downloads it. `ssr: false` also matters for correctness rather than only for
 * size: Monaco touches `window` as it initialises, so there is nothing useful
 * to prerender and attempting it fails.
 *
 * The wrapper is itself a Client Component because that is where Next requires
 * `ssr: false` to be declared — see the lazy-loading guide in the installed
 * Next documentation.
 */

import dynamic from "next/dynamic";

import { Spinner } from "@/components/ui/spinner";

export type { CodeEditorProps } from "./code-editor";

export const ReviewEditor = dynamic(() => import("./code-editor"), {
  loading: () => (
    <div className="flex h-full w-full items-center justify-center">
      <Spinner />
    </div>
  ),
  ssr: false,
});
