import { NextResponse } from "next/server";

import { captureAndRecord } from "@/lib/pi/artifacts/artifact-record";
import { putSnapshot } from "@/lib/pi/artifacts/artifact-snapshot-cache";
import { readProjectSnapshot } from "@/lib/pi/artifacts/artifact-snapshot";
import { commitStaged } from "@/lib/pi/review/review-apply";
import { resolveReviewTarget } from "@/lib/pi/review/review-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Commit what the operator staged, as the operator.
 *
 * This is the act the whole panel exists to make possible, and the reason it
 * is a route of its own rather than an action parameter on the review read:
 * everything else here is reversible, and this is the one that writes history.
 *
 * The commit uses the repository's own configured identity and adds no
 * trailer. It should be indistinguishable from one made by hand in a terminal,
 * because that is what it is — the agent proposed, a person approved.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const body = await request.json().catch(() => null);
  const message = typeof body?.message === "string" ? body.message : "";

  const target = await resolveReviewTarget(id, body?.project ?? null);
  if (!target) {
    return NextResponse.json(
      { message: "Not a project this session is linked to.", ok: false },
      { status: 400 },
    );
  }

  // Seed "before" with what the repository looked like immediately before
  // this commit, for THIS session. Overwriting whatever the chained cache
  // already held here is correct, not a loss: nothing between the last seed
  // and now is this session's tool-call activity, since the operator drives
  // this route directly, and a stale "before" would only make the upcoming
  // diff noisier.
  const before = await readProjectSnapshot(target.link.path, target.root);
  putSnapshot(id, before);

  const result = await commitStaged(target.root, message);

  // The whole point of capturing here, synchronously, before responding: the
  // panel exists precisely because the operator commits from session A while
  // other sessions may be live against the same repository. Every one of
  // them will eventually notice HEAD moved and try to attribute this sha to
  // itself — see claimCommits' docblock in artifact-snapshot-cache.ts. The
  // sha must be claimed for this session before the response returns, or a
  // sibling session's own tool-call capture (racing on the same `git status`)
  // can win the claim first and the commit is attributed to work that never
  // touched it.
  if (result.ok) {
    await captureAndRecord({
      attribution: "turn",
      command: null,
      output: null,
      projects: [{ projectPath: target.link.path, root: target.root }],
      roundId: null,
      sessionId: id,
      toolCallId: null,
      toolName: null,
      turnId: null,
      turnStartedAt: before.at,
    });
  }

  return NextResponse.json(result);
}
