import { handleRouteError } from "@/lib/api-helpers";
import { resolveSessionPromptContext } from "@/lib/pi/session-prompt-context";
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
    const { user } = await requireSessionOwner(id);
    userId = user.id;
  } catch (error) {
    return handleRouteError(error, "Unable to authorize session.");
  }

  const supabase = await createClient();
  const { projectPath, systemPrompt } = await resolveSessionPromptContext(
    supabase,
    id,
    userId,
  );

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
        projectPath,
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
