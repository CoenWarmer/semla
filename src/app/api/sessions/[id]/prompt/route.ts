import { handleRouteError, requireUser } from "@/lib/api-helpers";
import {
  createSession,
  readSessionCreateRequest,
  sessionExistsOnDisk,
} from "@/lib/pi/session-create";
import { parseRequestedSessionId } from "@/lib/pi/session-id";
import { resolveSessionPromptContext } from "@/lib/pi/session-prompt-context";
import { recordTurnStart } from "@/lib/pi/review-service";
import { runPiPrompt } from "@/lib/pi/session-service";
import { requireSessionOwner } from "@/lib/session-auth";
import { createClient } from "@/lib/supabase/server";
import { PI_TOOLS } from "@/lib/pi/runtime-config";

export const runtime = "nodejs";

const encoder = new TextEncoder();

const eventPayload = (event: unknown) =>
  encoder.encode(`data: ${JSON.stringify(event)}\n\n`);

const heartbeatPayload = encoder.encode(": keep-alive\n\n");

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = (await request.json().catch((error: unknown) => {
    console.error("[api:sessions/prompt] Invalid JSON body:", error);
    return null;
  })) as {
    /** Present when this prompt is also what brings the session into being. */
    create?: unknown;
    editEntryId?: unknown;
    model?: { modelId?: unknown; provider?: unknown };
    text?: unknown;
    tools?: unknown;
  } | null;
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  // Present when this prompt replaces an earlier one. runPiPrompt moves the
  // session leaf to that entry's parent so this turn supersedes it.
  const editEntryId =
    typeof body?.editEntryId === "string" && body.editEntryId.trim()
      ? body.editEntryId.trim()
      : null;
  const modelId =
    typeof body?.model?.modelId === "string" ? body.model.modelId : "";
  const provider =
    typeof body?.model?.provider === "string" ? body.model.provider : "";
  const selectedTools =
    body?.tools === undefined
      ? [...PI_TOOLS]
      : Array.isArray(body.tools) &&
    body.tools.every(
      (tool): tool is string =>
        typeof tool === "string" &&
        (PI_TOOLS as readonly string[]).includes(tool),
    )
      ? [...new Set(body.tools)]
      : undefined;

  if (!text) {
    return Response.json({ error: "A prompt is required." }, { status: 400 });
  }

  if (!provider || !modelId) {
    return Response.json({ error: "A model is required." }, { status: 400 });
  }

  if (!selectedTools) {
    return Response.json({ error: "Invalid tool selection." }, { status: 400 });
  }

  let userId: string;
  try {
    /**
     * The session may not exist yet.
     *
     * /sessions/new mints the id and navigates without waiting, so the first
     * prompt is also the request that brings the session into being. Doing it
     * here rather than as a separate call is one round trip rather than two
     * between arriving on the page and the agent starting work.
     *
     * `create` is what /sessions/new knew and this route otherwise could not:
     * the project the session is anchored to, and its title. A prompt for a
     * missing session that carries no `create` is still a 404 — the caller is
     * addressing something that never existed.
     */
    if (body?.create && !sessionExistsOnDisk(id)) {
      // The id is a route parameter, and creating means writing a file named
      // after it — `<session dir>/<id>.json`. Every other path through this
      // route only ever read a session that already existed, so an id that
      // could climb out of that directory never reached a write before. It is
      // validated to a uuid here, and a prompt is refused rather than silently
      // retargeted.
      const newId = parseRequestedSessionId(id);

      if (!newId) {
        return Response.json({ error: "Invalid session id." }, { status: 400 });
      }

      const { supabase: creating, user } = await requireUser();
      const { project, title } = readSessionCreateRequest(body.create);

      const created = await createSession({
        client: creating,
        id: newId,
        project,
        title,
        userId: user.id,
      });

      if (created.kind === "failed") {
        return Response.json({ error: created.message }, { status: 500 });
      }
    }

    // Still checked, and against the record that now exists: creating a session
    // does not authorise prompting one, and the id may name a session somebody
    // else owns.
    const { user } = await requireSessionOwner(id);
    userId = user.id;
  } catch (error) {
    return handleRouteError(error, "Unable to authorize session.");
  }

  const supabase = await createClient();
  const { projects, systemPrompt } = await resolveSessionPromptContext(
    supabase,
    id,
    userId,
  );

  /**
   * Mark where each project stands before the agent can touch anything.
   *
   * Awaited rather than fired off, because the whole value of the mark is that
   * it predates the turn's first write — a mark taken concurrently with the
   * agent's opening `edit` would record that edit as pre-existing and the
   * review panel would not mention it.
   *
   * Wrapped because it must never cost the turn. Without a mark the panel
   * still works; it simply cannot attribute a change to this turn, so nothing
   * opens by itself and the operator opens it by hand.
   */
  try {
    await recordTurnStart(id);
  } catch (error) {
    console.error("[api:sessions/prompt] Unable to mark the turn start:", error);
  }

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // Already closed (client disconnected before runPiPrompt finished).
        }
      };

      // Guard against enqueue-after-close when the client disconnects mid-stream.
      const send = (event: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(eventPayload(event));
        } catch {
          // Client disconnected — drop the event silently.
        }
      };

      // Heartbeat: keeps the SSE connection alive across browser/proxy idle timeouts.
      const heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(heartbeatPayload);
        } catch {
          // Client disconnected.
        }
      }, 30_000);

      // Hard deadline: force-close if runPiPrompt hasn't finished after 30 minutes.
      // Wiki ingestion sessions can run 10–20 min; 30 min is a safe upper bound.
      const deadline = setTimeout(() => {
        console.error(`[api:sessions/prompt] Stream deadline exceeded for session ${id} — force-closing`);
        send({ message: "Session timed out. Please retry.", type: "error" });
        close();
      }, 30 * 60 * 1000);

      void runPiPrompt({
        editEntryId,
        model: { modelId, provider },
        onEvent: send,
        projects,
        semlaSessionId: id,
        systemPrompt,
        text,
        tools: selectedTools,
      })
        .catch((error: unknown) => {
          send({
            message:
              error instanceof Error ? error.message : "Pi could not process the prompt.",
            type: "error",
          });
        })
        .finally(() => {
          clearInterval(heartbeat);
          clearTimeout(deadline);
          close();
        });
    },
  });

  return new Response(stream, {
    headers: {
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream",
    },
  });
}
