"use client";

import { useEffect } from "react";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-4">
      <p className="text-sm text-destructive">Something went wrong.</p>
      <button
        className="text-sm underline"
        onClick={reset}
        type="button"
      >
        Try again
      </button>
    </div>
  );
}
