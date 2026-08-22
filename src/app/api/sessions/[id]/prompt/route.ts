import { runPiPrompt } from "@/lib/pi/session-service";
import { requireSessionOwner } from "@/lib/session-auth";

export const runtime = "nodejs";

const encoder = new TextEncoder();

const eventPayload = (event: unknown) =>
  encoder.encode(`data: ${JSON.stringify(event)}\n\n`);

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = (await request.json().catch(() => null)) as {
    model?: { modelId?: unknown; provider?: unknown };
    text?: unknown;
  } | null;
  const text = typeof body?.text === "string" ? body.text.trim() : "";
  const modelId =
    typeof body?.model?.modelId === "string" ? body.model.modelId : "";
  const provider =
    typeof body?.model?.provider === "string" ? body.model.provider : "";

  if (!text) {
    return Response.json({ error: "A prompt is required." }, { status: 400 });
  }

  if (!provider || !modelId) {
    return Response.json({ error: "A model is required." }, { status: 400 });
  }

  try {
    await requireSessionOwner(id);
  } catch (error) {
    if (error instanceof Response) {
      return error;
    }

    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "Unable to authorize session.",
      },
      { status: 500 }
    );
  }

  const stream = new ReadableStream({
    start(controller) {
      const send = (event: unknown) => controller.enqueue(eventPayload(event));

      void runPiPrompt({
        model: { modelId, provider },
        onEvent: send,
        semlaSessionId: id,
        text,
      })
        .catch((error: unknown) => {
          send({
            message:
              error instanceof Error ? error.message : "Pi could not process the prompt.",
            type: "error",
          });
        })
        .finally(() => controller.close());
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
