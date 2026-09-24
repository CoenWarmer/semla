"use client";

/**
 * Lets the operator override the app's core CSS color variables, one set for
 * light mode and one for dark mode.
 *
 * A native `<input type="color">` per variable rather than a text field for
 * an oklch() triple: the browser's own color picker already speaks hex, and
 * a saved hex string is a value CSS accepts directly as a color-property
 * value, so no oklch conversion is needed on either side of the round trip.
 * The built-in theme's own oklch() values stay untouched in globals.css —
 * this only ever writes a per-user override on top of them.
 */

import { Button } from "@/components/ui/button";
import {
  useUpdateThemeColors,
  useUserSettings,
} from "@/hooks/use-user-settings";
import {
  THEME_COLOR_VARIABLES,
  type ThemeColorOverrides,
  type ThemeColorVariable,
  type ThemeColorVariables,
} from "@/lib/theme-colors";
import { useState } from "react";

const MODES = ["light", "dark"] as const;
type Mode = (typeof MODES)[number];

const VARIABLE_LABELS: Record<ThemeColorVariable, string> = {
  background: "Background",
  foreground: "Text",
  card: "Card background",
  "card-foreground": "Card text",
  primary: "Primary",
  "primary-foreground": "Primary text",
  secondary: "Secondary",
  "secondary-foreground": "Secondary text",
  accent: "Accent",
  "accent-foreground": "Accent text",
  border: "Border",
};

// A fallback swatch value for a variable with no saved override yet. The
// picker needs some hex to show; it does not have to match the built-in
// theme's oklch() value, since an untouched swatch is never written back
// unless the operator actually changes it and hits Save.
const FALLBACK_SWATCH = "#888888";

const EMPTY_OVERRIDES: ThemeColorOverrides = { light: {}, dark: {} };

export function ThemeColorEditor() {
  const { data: settings, isPending } = useUserSettings();
  const updateMutation = useUpdateThemeColors();

  const [mode, setMode] = useState<Mode>("light");
  // null = no pending edit; the displayed values are derived from settings.
  const [pending, setPending] = useState<ThemeColorOverrides | null>(null);

  const saved = settings?.theme_colors ?? EMPTY_OVERRIDES;
  const value = pending ?? saved;
  const isDirty = pending !== null;

  const handleChange = (variable: ThemeColorVariable, hex: string) => {
    const next: ThemeColorOverrides = {
      light: { ...value.light },
      dark: { ...value.dark },
    };
    next[mode] = { ...next[mode], [variable]: hex };
    setPending(next);
  };

  const handleClear = (variable: ThemeColorVariable) => {
    const next: ThemeColorOverrides = {
      light: { ...value.light },
      dark: { ...value.dark },
    };
    const modeVars: ThemeColorVariables = { ...next[mode] };
    delete modeVars[variable];
    next[mode] = modeVars;
    setPending(next);
  };

  const handleSave = () => {
    updateMutation.mutate(
      { themeColors: isEmpty(value) ? null : value },
      { onSuccess: () => setPending(null) },
    );
  };

  const handleResetAll = () => {
    setPending(EMPTY_OVERRIDES);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        {MODES.map((m) => (
          <Button
            key={m}
            onClick={() => setMode(m)}
            size="sm"
            variant={mode === m ? "secondary" : "ghost"}
          >
            {m === "light" ? "Light mode" : "Dark mode"}
          </Button>
        ))}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {THEME_COLOR_VARIABLES.map((variable) => {
          const override = value[mode][variable];
          return (
            <div className="flex items-center justify-between gap-3" key={variable}>
              <label
                className="text-sm"
                htmlFor={`theme-color-${mode}-${variable}`}
              >
                {VARIABLE_LABELS[variable]}
              </label>
              <div className="flex items-center gap-2">
                <input
                  className="h-8 w-12 cursor-pointer rounded border"
                  disabled={isPending}
                  id={`theme-color-${mode}-${variable}`}
                  onChange={(e) => handleChange(variable, e.target.value)}
                  type="color"
                  value={override ?? FALLBACK_SWATCH}
                />
                {override && (
                  <Button
                    onClick={() => handleClear(variable)}
                    size="sm"
                    variant="ghost"
                  >
                    Reset
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="flex items-center gap-2">
        <Button
          disabled={!isDirty || updateMutation.isPending}
          onClick={handleSave}
          size="sm"
        >
          {updateMutation.isPending ? "Saving…" : "Save"}
        </Button>
        <Button onClick={handleResetAll} size="sm" variant="ghost">
          Reset all to defaults
        </Button>
        {updateMutation.isError && (
          <span className="text-destructive text-sm">
            {updateMutation.error.message}
          </span>
        )}
        {updateMutation.isSuccess && pending === null && (
          <span className="text-muted-foreground text-sm">Saved</span>
        )}
      </div>
    </div>
  );
}

const isEmpty = (overrides: ThemeColorOverrides): boolean =>
  Object.keys(overrides.light).length === 0 &&
  Object.keys(overrides.dark).length === 0;
