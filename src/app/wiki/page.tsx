import { Suspense } from "react";
import { WikiBrowser } from "@/components/wiki/wiki-browser";

export default function WikiPage() {
  return (
    <Suspense>
      <WikiBrowser />
    </Suspense>
  );
}
