import type { Json } from "@/types/database.types";

// A UTF-16 surrogate without its pair. JSON.stringify emits these verbatim as
// \udXXX escapes, which PostgREST's parser rejects outright — the whole request
// fails with "Empty or invalid json" rather than just dropping the character.
//
// This is reachable from ordinary agent output: pi-dynamic-workflows truncates
// each agent's resultPreview to a fixed number of UTF-16 code units, so a
// preview ending in an emoji is cut between the emoji's two halves.
const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

// NUL cannot be stored in a Postgres text or jsonb value at all.
export const sanitizeText = (value: string): string =>
  value.replace(LONE_SURROGATE, "\uFFFD").replaceAll("\u0000", "");

const jsonWithStrings = (
  value: unknown,
  transform: (text: string) => string,
): Json =>
  JSON.parse(
    JSON.stringify(value, (_key, entry: unknown) =>
      typeof entry === "string" ? transform(entry) : entry,
    ),
  ) as Json;

/** Every payload bound for Postgres goes through here. */
export const toJson = (value: unknown): Json =>
  jsonWithStrings(value, sanitizeText);

// Last-resort transliteration for a payload Postgres refused for reasons
// sanitizeText does not cover. Structure and field types are preserved — only
// the characters degrade — so the entry still restores as a valid Pi entry.
export const toAsciiJson = (value: unknown): Json =>
  jsonWithStrings(value, (text) =>
    sanitizeText(text).replace(/[^\t\n\r\x20-\x7E]/g, "?"),
  );
