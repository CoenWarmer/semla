/**
 * Theme color variable names and override types.
 *
 * Split out of user-settings-store.ts because that module imports node:fs at
 * the top level, and two client components (theme-color-provider.tsx,
 * theme-color-editor.tsx) need these names and types without pulling that
 * import into the browser bundle — see client-boundary.test.ts, which fails
 * the whole page's compilation on exactly this chain.
 */

/**
 * The core theme variables exposed for user configuration. A deliberately
 * curated subset of globals.css's full variable list — sidebar, chart-*, and
 * semla-following are internal presentation details rather than "the app's
 * colors" a user would expect to tune.
 */
export const THEME_COLOR_VARIABLES = [
  "background",
  "foreground",
  "card",
  "card-foreground",
  "primary",
  "primary-foreground",
  "secondary",
  "secondary-foreground",
  "accent",
  "accent-foreground",
  "border",
] as const;

export type ThemeColorVariable = (typeof THEME_COLOR_VARIABLES)[number];

export type ThemeColorVariables = Partial<Record<ThemeColorVariable, string>>;

export interface ThemeColorOverrides {
  light: ThemeColorVariables;
  dark: ThemeColorVariables;
}
