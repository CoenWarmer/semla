/**
 * The name of the last project picked from the sidebar's project combobox,
 * mirrored to localStorage.
 *
 * Per-browser, not per-user-on-disk: this is a shortcut for the picker's own
 * list, not data that needs to survive a reinstall or follow the user to
 * another machine, so it does not belong beside `user-settings-store.ts` or
 * `panel-layout-store.ts`. Same pattern as the sidebar's own width/open state
 * in `components/ui/sidebar.tsx`.
 */

const KEY = "semla.last-selected-project";

/** Absent during server rendering, and can throw with storage disabled. */
const storage = (): Storage | null => {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
};

export function readLastSelectedProject(): string | null {
  try {
    return storage()?.getItem(KEY) ?? null;
  } catch {
    return null;
  }
}

export function writeLastSelectedProject(name: string): void {
  try {
    storage()?.setItem(KEY, name);
  } catch {
    // Private mode, or a full quota. Losing the shortcut costs nothing but
    // the shortcut itself.
  }
}
