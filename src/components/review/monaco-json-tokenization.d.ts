/**
 * `monaco-editor` ships a `.d.ts` for `languages/features/json/register.js`
 * but not for the sibling `tokenization.js` it re-exports from — see the
 * comment above this module's import in `monaco-setup.ts` for why that file
 * is imported directly instead.
 */
declare module "monaco-editor/languages/features/json/tokenization.js" {
  import type { languages } from "monaco-editor/editor/editor.api.js";

  export function createTokenizationSupport(
    supportComments: boolean,
  ): languages.TokensProvider;
}
