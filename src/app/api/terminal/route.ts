import { randomUUID } from "node:crypto";

import { spawn } from "node-pty";

import { handleRouteError, requireUser } from "@/lib/api-helpers";
import {
  registerTerminal,
  sweepIdleTerminals,
  terminalCwd,
  terminalShell,
} from "@/lib/pi/terminal-store";
import { isValidCols, isValidRows } from "@/lib/terminal-control";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Start a shell on the machine running this server.
 *
 * Authorisation is `requireUser`, the same as everything else: open when the
 * server is bound to loopback, because then there is nobody else to be, and
 * Supabase authentication when it is exposed.
 *
 * Worth being plain about what this is. Every other route reads or edits
 * Semla's own state; this one hands out a shell. On a loopback bind that grants
 * nothing the agent's bash tool does not already have. On an exposed one it
 * makes authentication the only thing between a visitor and the server's
 * machine.
 */
export async function POST(request: Request) {
  try {
    await requireUser();

    const body = await request.json().catch(() => ({}));
    const cols = isValidCols(body?.cols) ? body.cols : 80;
    const rows = isValidRows(body?.rows) ? body.rows : 24;

    // Cheap, and this is the only moment a terminal is created — so it is the
    // natural place to notice the ones whose browsers never said goodbye.
    sweepIdleTerminals();

    const id = randomUUID();
    const pty = spawn(terminalShell(), [], {
      cols,
      cwd: terminalCwd(),
      // TERM is what tells programs they may use colour and cursor addressing.
      // Without it they fall back to dumb output and the emulator has nothing
      // to render.
      env: { ...process.env, TERM: "xterm-256color" },
      name: "xterm-256color",
      rows,
    });

    registerTerminal(id, pty);

    return Response.json({ id }, { status: 201 });
  } catch (error) {
    return handleRouteError(error, "Unable to start a terminal.");
  }
}
