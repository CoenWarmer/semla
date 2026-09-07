"use client";

import { AppConsole } from "@/components/app-console";
import { SessionAgentsPanel } from "@/components/session-agents-panel";
import { SessionBranchesPanel } from "@/components/session-branches-panel";
import { ElementPicker } from "@/components/element-picker";

/**
 * The strip along the foot of the app: the console, and the buttons the
 * current session contributes beside it.
 *
 * A single component rather than four siblings left loose in layout.tsx,
 * because that is what they are — one bar, not four independently placed
 * pieces that happen to end up adjacent. `SessionAgentsPanel`,
 * `SessionBranchesPanel` and `ElementPicker` each source their own
 * session-turn data from the query cache via `useParams()`
 * (session-live-state.ts) rather than as props, but they still portal their
 * button and panel into `AppConsole`'s bar slots — see bottom-panel.tsx —
 * so "Console", "Select", "Branches" and "Agents" render as one row of
 * buttons sharing one panel area, not four separately laid-out strips.
 * `AppConsole` has to render last: it owns the slots the other three portal
 * into, and a slot has to exist before anything can render into it.
 */
export function BottomBar() {
  return (
    <>
      <SessionAgentsPanel />
      <SessionBranchesPanel />
      <ElementPicker />
      <AppConsole />
    </>
  );
}
