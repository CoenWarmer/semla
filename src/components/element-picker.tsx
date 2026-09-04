"use client";

/**
 * "Select an element" — point at a piece of Semla's own UI and open the
 * Review panel on the source file that rendered it.
 *
 * Development only, and gated on `NODE_ENV` rather than a user setting: the
 * whole mechanism reads React's internal `_debugStack`, which does not exist
 * in a production build and would silently find nothing there anyway. Not
 * hidden behind a feature flag beyond that, because there is no user to hide
 * it from — this runs on the machine that is developing Semla.
 *
 * Arms a "picking" mode rather than always listening: a permanent
 * mouseover/click hijack on every element in the app would fight every other
 * click handler in the UI it is meant to help inspect.
 */

import { Crosshair } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useElementTarget } from "@/components/element-target-provider";
import { locateElement } from "@/lib/element-locator";

/** Only meaningful in dev: `_debugStack` is a dev-runtime-only field. */
const AVAILABLE = process.env.NODE_ENV === "development";

/**
 * A highlight box tracking the element under the pointer while picking.
 *
 * A single absolutely-positioned div that follows `getBoundingClientRect`,
 * rather than an outline style toggled on the hovered element itself: this
 * repository already has the review overlay demonstrating that pattern for
 * an unrelated reason (see review-panel.tsx) — not painting the target
 * changes anything about it, including layout, which a border or outline can.
 */
function HoverBox({ rect }: { rect: DOMRect | null }) {
  if (!rect) return null;
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed z-[999] rounded-sm border-2 border-primary bg-primary/10"
      style={{
        height: rect.height,
        left: rect.left,
        top: rect.top,
        width: rect.width,
      }}
    />
  );
}

export function ElementPicker({ sessionId }: { sessionId: string }) {
  const [picking, setPicking] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hoverRect, setHoverRect] = useState<DOMRect | null>(null);
  const elementTarget = useElementTarget();
  // The picker's own UI must never highlight or resolve itself — clicking the
  // toggle button while armed would otherwise try to locate the button.
  const rootRef = useRef<HTMLDivElement>(null);

  const stop = useCallback(() => {
    setPicking(false);
    setHoverRect(null);
  }, []);

  useEffect(() => {
    if (!picking) return;

    const onMove = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || rootRef.current?.contains(target)) {
        setHoverRect(null);
        return;
      }
      setHoverRect(target.getBoundingClientRect());
    };

    const onClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || rootRef.current?.contains(target)) {
        return;
      }

      // Swallowed here, not left to run: the point of picking is to inspect
      // the element, not to also fire whatever it does — a picked button
      // must not also submit the form it sits in.
      event.preventDefault();
      event.stopPropagation();

      stop();
      setResolving(true);
      setError(null);

      void locateElement(target)
        .then(async (located) => {
          if (!located) {
            setError(
              "Couldn't trace that element back to a Semla source file.",
            );
            return;
          }

          // Attaches Semla's own repo to this session (idempotent) and
          // confirms the path is inside it, then hands the resolved
          // {project, path} to the session component so it can open the
          // Review panel — the same shape any other file selection there
          // uses.
          const res = await fetch(
            `/api/sessions/${sessionId}/element-target`,
            {
              body: JSON.stringify({ path: located.file }),
              headers: { "Content-Type": "application/json" },
              method: "POST",
            },
          );
          const body = await res.json().catch(() => null);
          if (!res.ok) {
            setError(body?.error ?? "Unable to open that element's source.");
            return;
          }

          elementTarget.request({
            line: located.line,
            path: body.path,
            project: body.project,
          });
        })
        .catch(() => setError("Unable to open that element's source."))
        .finally(() => setResolving(false));
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") stop();
    };

    // Capture phase: this has to see the click before the element's own
    // handlers do, which is also what makes preventDefault/stopPropagation
    // here effective against them.
    document.addEventListener("pointermove", onMove, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKeyDown);
    // The whole page, not just this button: the point is to pick an element
    // anywhere on screen, and the crosshair has to say so wherever the
    // pointer goes.
    document.body.classList.add("cursor-crosshair");

    return () => {
      document.removeEventListener("pointermove", onMove, true);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKeyDown);
      document.body.classList.remove("cursor-crosshair");
    };
  }, [elementTarget, picking, sessionId, stop]);

  if (!AVAILABLE) return null;

  return (
    <div className="relative" ref={rootRef}>
      <Button
        aria-pressed={picking}
        onClick={() => (picking ? stop() : setPicking(true))}
        size="sm"
        title="Select an element to open its source in Review"
        variant={picking ? "secondary" : "ghost"}
      >
        {resolving ? (
          <Spinner className="size-3.5" />
        ) : (
          <Crosshair className="size-3.5" />
        )}
        {picking ? "Click an element…" : "Select"}
      </Button>

      {picking && <HoverBox rect={hoverRect} />}

      {error && (
        <div className="absolute top-full left-0 z-[999] mt-1 w-64 rounded-md border bg-popover px-2 py-1.5 text-xs text-muted-foreground shadow-md">
          {error}
        </div>
      )}
    </div>
  );
}
