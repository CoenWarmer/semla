/**
 * The `open_review` tool: open Semla's Review panel in the browser, optionally
 * already pointed at a file and line.
 *
 * Fire-and-forget, in the shape code-map.ts established: the tool resolves
 * something structured, hands it back in `details`, and returns. It does not
 * wait for the operator the way ask-user.ts and feature-spec.ts do — there is
 * no answer to wait for, and a turn that blocked on the operator having looked
 * at a panel would be a worse tool than one that simply shows them.
 *
 * The one thing it does do before returning is *resolve* the target. The rule
 * is the review API routes' rule, taken from review-service.ts rather than
 * re-derived: a project identifier must be one this session is linked to, and
 * a path must land inside that project once contained with `relative`. So the
 * target that reaches `details` is a validated, workspace-relative one, and
 * the browser is handed a place it is allowed to open rather than whatever the
 * model typed.
 *
 * Invalid input is thrown, not returned with `isError` — see code-map.ts for
 * why, and note that the message names what *is* linked, because the agent's
 * recovery is to call again with one of those.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { Type } from "typebox";

import { toRelativePath } from "@/lib/pi/workspace/file-browser";
import {
  resolveReviewFile,
  resolveReviewTarget,
} from "@/lib/pi/review/review-service";
import { sessionProjects } from "@/lib/pi/session/session-project";

const OpenReviewSchema = Type.Object(
  {
    project: Type.Optional(
      Type.String({
        description:
          "Workspace-relative path of the project to review, e.g. `semla`. Defaults to the session's anchor project. Must be a project this session is linked to.",
      }),
    ),
    path: Type.Optional(
      Type.String({
        description:
          "Path of the file to open, relative to the project root. Omit to open the panel without selecting a file.",
      }),
    ),
    line: Type.Optional(
      Type.Integer({
        description:
          "One-based line to jump to in `path`. Omit to let the panel land on the file's first change.",
        minimum: 1,
      }),
    ),
    commitSha: Type.Optional(
      Type.String({
        description:
          "A commit of this session's to select in the panel's commit navigator.",
      }),
    ),
  },
  { additionalProperties: false },
);

export type OpenReviewParams = {
  commitSha?: string;
  line?: number;
  path?: string;
  project?: string;
};

/** The browser-shaped target carried in `details`; null means "just open it". */
export type OpenReviewTarget = {
  commitSha?: string;
  line?: number;
  path: string;
  project: string;
};

export type OpenReviewDetails = {
  target: OpenReviewTarget | null;
  type: "open-review";
};

/** What is available to open, for a refusal message the agent can act on. */
async function linkedProjectList(sessionId: string): Promise<string> {
  const links = await sessionProjects(sessionId);
  return links.length > 0
    ? links.map((link) => link.path).join(", ")
    : "(none — this session is not linked to any project)";
}

export default function openReviewExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "open_review",
    label: "Open review",
    description:
      "Open Semla's Review panel in the operator's browser, optionally already " +
      "pointed at a file and line. Use it to put a change you have just made in " +
      "front of the operator, so they are looking at the same diff you are " +
      "describing. The panel opens immediately; this tool does not wait for the " +
      "operator to respond.",
    promptGuidelines: [
      "Use this after a change worth a look, to show the operator the file and line that matters.",
      "Proactive use is expected, but sparingly — do not open the panel on every turn, only when there is something specific to see.",
      "Name the project and path precisely; both are validated against this session's linked projects and an invalid one is an error.",
    ],
    async execute(_toolCallId, params: OpenReviewParams, _signal, _onUpdate, ctx) {
      // Same as ask-user.ts / feature-spec.ts: the session id comes from the
      // runtime's own session manager, never from a parameter.
      const sessionId = ctx.sessionManager.getSessionId();

      // No project and no path: nothing to resolve, nothing to refuse. The
      // panel opens on whatever it shows by default.
      if (!params.project && !params.path) {
        return {
          content: [
            { text: "Opened the Review panel.", type: "text" as const },
          ],
          details: { target: null, type: "open-review" } satisfies OpenReviewDetails,
        };
      }

      const target = await resolveReviewTarget(sessionId, params.project ?? null);
      if (!target) {
        throw new Error(
          `"${params.project ?? "(session anchor)"}" is not a project this session is linked to. ` +
            `Linked projects: ${await linkedProjectList(sessionId)}.`,
        );
      }

      // A project with no path is a valid request: open the panel on that
      // project's review, with no file selected.
      if (!params.path) {
        return {
          content: [
            {
              text: `Opened the Review panel on ${target.link.path}.`,
              type: "text" as const,
            },
          ],
          details: {
            target: null,
            type: "open-review",
          } satisfies OpenReviewDetails,
        };
      }

      const absolute = resolveReviewFile(target, params.path);
      if (!absolute) {
        throw new Error(
          `"${params.path}" does not resolve inside ${target.link.path}. ` +
            "Give a path relative to the project root, not an absolute or escaping one. " +
            `Linked projects: ${await linkedProjectList(sessionId)}.`,
        );
      }

      // Derived from the contained absolute path rather than echoed from the
      // parameters, so what the browser opens is the path this module checked.
      const relPath = toRelativePath(target.root, absolute);

      return {
        content: [
          {
            text:
              `Opened the Review panel on ${target.link.path}/${relPath}` +
              `${params.line === undefined ? "" : ` at line ${params.line}`}.`,
            type: "text" as const,
          },
        ],
        details: {
          target: {
            ...(params.commitSha === undefined
              ? {}
              : { commitSha: params.commitSha }),
            ...(params.line === undefined ? {} : { line: params.line }),
            path: relPath,
            project: target.link.path,
          },
          type: "open-review",
        } satisfies OpenReviewDetails,
      };
    },
    parameters: OpenReviewSchema,
  });
}
