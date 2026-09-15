/**
 * Whether a tool call means wiki work has started, so the session view can
 * bring up the mini graph overlay.
 *
 * The signal has to come from the *main* session's tool stream, which is the
 * only one the session view observes directly. That used to include
 * `wiki_capture_source`, because subagents had no wiki tools and the main
 * agent captured every source itself. Now capture is fanned out to subagents,
 * whose tool calls travel inside workflow snapshots instead — so during a
 * healthy orient the main session never emits a capture at all, and the
 * overlay stopped appearing.
 *
 * `wiki_ingest` restores it, and is a better cue than capture was: capture
 * only produces source skeletons, so the graph had nothing to draw for the
 * several minutes it ran. Ingest is the point where entity and concept pages —
 * the actual nodes — start being written.
 *
 * The capture and init tools stay listed for the paths that still reach them:
 * a small repo the agent orients by hand, or a session that captures a single
 * source without fanning out.
 */
export const WIKI_ACTIVITY_TOOLS: readonly string[] = [
  "wiki_bootstrap",
  "wiki_init",
  "wiki_capture_source",
  "wiki_ingest",
];

export function startsWikiActivity(toolName: string): boolean {
  return WIKI_ACTIVITY_TOOLS.includes(toolName);
}
