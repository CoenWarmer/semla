"use client";

/**
 * Applies the user's saved theme color overrides as inline CSS variables on
 * `<html>`, once settings have loaded.
 *
 * Written directly on `documentElement.style` rather than through a
 * stylesheet: it needs to win over the `:root` / `.dark` declarations in
 * globals.css, and an inline style on the element those selectors target
 * already outranks them with no extra specificity trick required. Cleared
 * (not just left stale) whenever a variable's override is removed, so
 * "Reset" in the settings UI falls back to the built-in theme immediately
 * rather than needing a reload.
 */

import { useUserSettings } from "@/hooks/use-user-settings";
import { THEME_COLOR_VARIABLES } from "@/lib/stores/user-settings-store";
import { useEffect } from "react";

export function ThemeColorProvider() {
  const { data: settings } = useUserSettings();

  useEffect(() => {
    const root = document.documentElement;
    const isDark = root.classList.contains("dark");
    const overrides = settings?.theme_colors?.[isDark ? "dark" : "light"];

    for (const variable of THEME_COLOR_VARIABLES) {
      const value = overrides?.[variable];
      if (value) {
        root.style.setProperty(`--${variable}`, value);
      } else {
        root.style.removeProperty(`--${variable}`);
      }
    }
  }, [settings]);

  return null;
}
