/**
 * The `place_review_comments` tool: create several review comments, across
 * one or more files or projects, in a single call.
 *
 * `open_review`'s own `comment` parameter is deliberately one comment on one
 * file per call — it is a navigation tool that can also leave a note where it
 * lands, not a batch API. This tool is the batch API: an agent that has just
 * finished a change with findings scattered across several files should not
 * have to round-trip `open_review` once per file just to attach a comment
 * that will never navigate anywhere.
 *
 * Deliberately best-effort, not all-or-nothing. A batch where entry 4 of 10
 * names a path that does not exist should not cost the other nine their
 * comments — the caller already did the work of composing them, and a
 * mid-batch failure is exactly the situation where losing valid results
 * would be most annoying to redo. Every entry gets its own outcome in
 * `details.results`, keyed by its index in the request, so the agent can
 * retry precisely the ones that failed rather than re-sending the batch.
 *
 * No navigation, no panel side effect: unlike `open_review`, this tool never
 * calls `elementTarget.request`. An agent that wants the operator looking at
 * one of these comments still reaches for `open_review` for that — this tool
 * exists purely to get comments recorded, and session-event-router.ts pushes
 * the created ones into the review panel's query cache so they show up if
 * and when the panel is already open, without asking it to jump anywhere.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { Type } from "typebox";

import { toRelativePath } from "@/lib/pi/workspace/file-browser";
import { createReviewComment } from "@/lib/pi/review/review-comment-store";
import {
  resolveReviewFile,
  resolveReviewTarget,
  type ReviewTarget,
} from "@/lib/pi/review/review-service";
import { sessionProjects } from "@/lib/pi/session/session-project";
import type { ReviewComment } from "@/lib/review/review-comment-types";

const CommentBodySchema = Type.Object(
  {
    kind: Type.Union([Type.Literal("text"), Type.Literal("markdown")], {
      description:
        "\"markdown\" is rendered; \"text\" is shown verbatim with no formatting.",
    }),
    text: Type.String({
      description: "The explanation. Required regardless of kind.",
    }),
  },
  { additionalProperties: false },
);

const PlaceReviewCommentsSchema = Type.Object(
  {
    comments: Type.Array(
      Type.Object(
        {
          project: Type.Optional(
            Type.String({
              description:
                "Workspace-relative path of the project this entry is about, e.g. `semla`. Defaults to the session's anchor project. Must be a project this session is linked to.",
            }),
          ),
          path: Type.String({
            description: "Path of the file, relative to the project root.",
          }),
          line: Type.Integer({
            description: "One-based line the comment is about.",
            minimum: 1,
          }),
          endLine: Type.Optional(
            Type.Integer({
              description:
                "Last line the comment is about, inclusive. Defaults to `line` for a single-line comment. Must not be less than `line`.",
              minimum: 1,
            }),
          ),
          comment: CommentBodySchema,
        },
        { additionalProperties: false },
      ),
      {
        description:
          "One entry per comment. Entries may target different files, different projects, or the same file more than once.",
        minItems: 1,
      },
    ),
  },
  { additionalProperties: false },
);

export type PlaceReviewCommentsEntry = {
  project?: string;
  path: string;
  line: number;
  endLine?: number;
  comment: { kind: "text" | "markdown"; text: string };
};

export type PlaceReviewCommentsParams = {
  comments: PlaceReviewCommentsEntry[];
};

/**
 * One entry's outcome, indexed to match the request rather than filtered
 * down to only the successes — a caller retrying failures needs to know
 * which index in its own array each one was.
 */
export type PlaceReviewCommentsEntryResult =
  | { index: number; ok: true; comment: ReviewComment }
  | { index: number; ok: false; project?: string; path: string; error: string };

export type PlaceReviewCommentsDetails = {
  type: "place-review-comments";
  results: PlaceReviewCommentsEntryResult[];
};

/** What is available to open, for a refusal message the agent can act on. */
async function linkedProjectList(sessionId: string): Promise<string> {
  const links = await sessionProjects(sessionId);
  return links.length > 0
    ? links.map((link) => link.path).join(", ")
    : "(none — this session is not linked to any project)";
}

export default function placeReviewCommentsExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "place_review_comments",
    label: "Place review comments",
    description:
      "Create several review comments in one call, across one or more files " +
      "or projects. Unlike open_review's own `comment` parameter, this places " +
      "no navigation request — it only records comments so they appear the " +
      "next time the operator looks at those files in the Review panel.",
    promptGuidelines: [
      "Use this to leave several findings at once — e.g. after a review pass that touched multiple files — rather than calling open_review once per file just to attach a note.",
      "Each entry is independent: a bad path or project in one entry does not stop the others from being placed. Check `details.results` (by index) to see which succeeded.",
      "Name project and path precisely for each entry; both are validated against this session's linked projects the same way open_review's are.",
      "If you also want the operator looking at one of these right now, follow up with open_review — this tool never opens or navigates the panel.",
    ],
    async execute(toolCallId, params: PlaceReviewCommentsParams, _signal, _onUpdate, ctx) {
      const sessionId = ctx.sessionManager.getSessionId();

      const targetCache = new Map<string, ReviewTarget | null>();
      const resolveTarget = async (
        project: string | undefined,
      ): Promise<ReviewTarget | null> => {
        const key = project ?? "";
        if (!targetCache.has(key)) {
          targetCache.set(key, await resolveReviewTarget(sessionId, project ?? null));
        }
        return targetCache.get(key) ?? null;
      };

      const results: PlaceReviewCommentsEntryResult[] = [];

      for (const [index, entry] of params.comments.entries()) {
        if (entry.endLine !== undefined && entry.endLine < entry.line) {
          results.push({
            error: "`endLine` must not be less than `line`.",
            index,
            ok: false,
            path: entry.path,
            project: entry.project,
          });
          continue;
        }

        const target = await resolveTarget(entry.project);
        if (!target) {
          results.push({
            error:
              `"${entry.project ?? "(session anchor)"}" is not a project this session is linked to. ` +
              `Linked projects: ${await linkedProjectList(sessionId)}.`,
            index,
            ok: false,
            path: entry.path,
            project: entry.project,
          });
          continue;
        }

        const absolute = resolveReviewFile(target, entry.path);
        if (!absolute) {
          results.push({
            error:
              `"${entry.path}" does not resolve inside ${target.link.path}. ` +
              "Give a path relative to the project root, not an absolute or escaping one.",
            index,
            ok: false,
            path: entry.path,
            project: entry.project,
          });
          continue;
        }

        const relPath = toRelativePath(target.root, absolute);

        try {
          const comment = await createReviewComment({
            body:
              entry.comment.kind === "markdown"
                ? { kind: "markdown", markdown: entry.comment.text }
                : { kind: "text", text: entry.comment.text },
            endLine: entry.endLine ?? entry.line,
            filePath: relPath,
            projectPath: target.link.path,
            sessionId,
            startLine: entry.line,
            toolCallId,
          });
          results.push({ comment, index, ok: true });
        } catch (error) {
          results.push({
            error: error instanceof Error ? error.message : String(error),
            index,
            ok: false,
            path: entry.path,
            project: entry.project,
          });
        }
      }

      const successCount = results.filter((r) => r.ok).length;
      const failures = results.filter(
        (r): r is Extract<PlaceReviewCommentsEntryResult, { ok: false }> => !r.ok,
      );

      const lines = [
        `Placed ${successCount} of ${results.length} comment(s).`,
        ...failures.map(
          (f) => `- #${f.index} (${f.project ?? "(session anchor)"}/${f.path}): ${f.error}`,
        ),
      ];

      return {
        content: [{ text: lines.join("\n"), type: "text" as const }],
        details: {
          results,
          type: "place-review-comments",
        } satisfies PlaceReviewCommentsDetails,
      };
    },
    parameters: PlaceReviewCommentsSchema,
  });
}
