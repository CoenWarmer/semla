"use client";

import { useEffect, useRef, useState } from "react";

import type { TerminalControl } from "@/lib/terminal-control";

import "@xterm/xterm/css/xterm.css";

/**
 * Which shell this tab is attached to.
 *
 * Kept in sessionStorage so collapsing the bar and opening it again lands on
 * the same shell, with whatever you were in the middle of. Per tab, like
 * pending-prompt-store: two windows should get two shells, not fight over one.
 */
const TERMINAL_ID_KEY = "semla:terminal-id";

const send = (id: string, control: TerminalControl) =>
  fetch(`/api/terminal/${id}`, {
    body: JSON.stringify(control),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });

/**
 * A real shell, running where the server runs.
 *
 * xterm rather than the read-only Terminal component this bar used to show:
 * that renders a string through ansi-to-react, which understands colour but not
 * cursor movement or the alternate screen — so vim, top, and anything that
 * redraws would come out as noise. This is an emulator.
 *
 * Everything here runs after mount and only in the browser; the module is
 * imported dynamically by the console bar because xterm reaches for `document`
 * as it loads.
 */
export function AppTerminal() {
  const hostRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string>();

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let disposed = false;
    const abort = new AbortController();
    // Assigned during setup and used by teardown, which may run first if the
    // component unmounts while the shell is still being started.
    let cleanupTerm: (() => void) | undefined;

    const run = async () => {
      // Loaded here rather than at module scope so the bundle for every other
      // page does not carry an emulator nobody opened.
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);
      if (disposed) return;

      const term = new Terminal({
        cursorBlink: true,
        fontFamily:
          'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
        fontSize: 12,
        // Matches the panel it sits in; xterm paints its own background.
        theme: { background: "#09090b", foreground: "#e4e4e7" },
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(host);
      fit.fit();
      cleanupTerm = () => term.dispose();

      const openStream = (id: string) =>
        fetch(`/api/terminal/${id}`, { signal: abort.signal });

      const create = async (): Promise<string | null> => {
        const created = await fetch("/api/terminal", {
          body: JSON.stringify({ cols: term.cols, rows: term.rows }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });
        if (!created.ok) return null;

        const { id } = (await created.json()) as { id: string };
        sessionStorage.setItem(TERMINAL_ID_KEY, id);
        return id;
      };

      /**
       * Attach to this tab's shell, or start one.
       *
       * Attaching *is* the liveness check — a dead id answers the stream with
       * 404, which is one round trip rather than a probe followed by a request
       * that can still race it.
       */
      const remembered = sessionStorage.getItem(TERMINAL_ID_KEY);
      let id = remembered;
      let response = remembered ? await openStream(remembered) : null;

      if (!response || response.status === 404) {
        // Whatever was remembered is gone — most likely the server restarted.
        id = await create();
        if (disposed) return;
        if (!id) {
          setError("Could not start a terminal.");
          return;
        }
        response = await openStream(id);
      }

      if (disposed || !id) return;

      const terminalId = id;
      term.onData((data) => void send(terminalId, { data, type: "input" }));

      // The container is what changes size — the window, the bar, the sidebar —
      // so watch that and let the addon work out cols and rows from it.
      const observer = new ResizeObserver(() => {
        // Collapsing the bar hides the panel rather than unmounting it, so the
        // host measures zero. Fitting to that would ask for a nought-column
        // terminal and lose the layout the shell is drawing against.
        if (host.clientWidth === 0 || host.clientHeight === 0) return;

        try {
          fit.fit();
        } catch {
          // Mid-teardown, when there is nothing left to measure.
          return;
        }
        void send(terminalId, { cols: term.cols, rows: term.rows, type: "resize" });
      });
      observer.observe(host);

      cleanupTerm = () => {
        observer.disconnect();
        term.dispose();
      };

      if (!response.ok || !response.body) {
        sessionStorage.removeItem(TERMINAL_ID_KEY);
        setError("The terminal is no longer running.");
        return;
      }

      // The same framing the session stream uses, read the same way.
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (!disposed) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";

        for (const frame of frames) {
          const line = frame.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          const { data } = JSON.parse(line.slice(6)) as { data: string };
          term.write(data);
        }
      }
    };

    run().catch((cause: unknown) => {
      if ((cause as Error)?.name === "AbortError") return;
      console.error("[terminal]", cause);
      setError("The terminal disconnected.");
    });

    return () => {
      disposed = true;
      abort.abort();
      cleanupTerm?.();
      // Deliberately not killing the shell: the bar closes far more often than
      // somebody finishes with what they were running. The server reclaims one
      // nobody reattaches to.
    };
  }, []);

  return (
    <div className="relative h-full w-full bg-zinc-950">
      {error && (
        <p className="absolute inset-x-0 top-0 z-10 bg-zinc-950/90 px-3 py-1 text-xs text-destructive">
          {error}
        </p>
      )}
      <div className="h-full w-full px-2 py-1" ref={hostRef} />
    </div>
  );
}
