/**
 * Guards the hand-added `review_comments` block in database.types.ts against
 * the migration it is supposed to mirror.
 *
 * Same reasoning as session-artifacts-schema.test.ts: the migration is
 * deliberately not applied, so nothing regenerated the types file, and a
 * hand edit can drift with nothing to catch it. Checked as text against both
 * files, so it needs no running database.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const migrationPath = join(
  process.cwd(),
  "supabase/migrations/20260922000000_add_review_comments.sql",
);
const typesPath = join(process.cwd(), "src/types/database.types.ts");

const migration = readFileSync(migrationPath, "utf8");
const types = readFileSync(typesPath, "utf8");

/** The `review_comments` block, isolated from the rest of database.types.ts. */
function extractTypesBlock(): string {
  const start = types.indexOf("review_comments: {");
  expect(start, "review_comments block not found in database.types.ts").toBeGreaterThan(-1);
  const end = types.indexOf("session_artifacts: {", start);
  expect(end, "session_artifacts block not found after review_comments").toBeGreaterThan(start);
  return types.slice(start, end);
}

const EXPECTED_COLUMNS = [
  "id",
  "session_id",
  "project_path",
  "file_path",
  "start_line",
  "end_line",
  "body",
  "tool_call_id",
  "dismissed_at",
  "created_at",
];

/** Column name -> { notNull, hasDefault } as declared in the `create table`. */
function parseMigrationColumns(): Map<string, { notNull: boolean; hasDefault: boolean }> {
  const tableMatch = /create table public\.review_comments \(([\s\S]*?)\n\);/.exec(migration);
  expect(tableMatch, "create table public.review_comments not found").not.toBeNull();
  const body = tableMatch![1]!;

  const columns = new Map<string, { notNull: boolean; hasDefault: boolean }>();
  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("--")) continue;
    if (/^constraint\b/i.test(line)) continue;

    const columnMatch = /^([a-z_]+)\s+/i.exec(line);
    if (!columnMatch) continue;
    const name = columnMatch[1]!;
    if (!EXPECTED_COLUMNS.includes(name)) continue;

    columns.set(name, {
      hasDefault: /\bdefault\b/i.test(line),
      notNull: /\bnot null\b/i.test(line) || name === "id",
    });
  }
  return columns;
}

describe("review_comments schema — migration vs. hand-added types", () => {
  const migrationColumns = parseMigrationColumns();
  const typesBlock = extractTypesBlock();

  it("declared every expected column", () => {
    for (const column of EXPECTED_COLUMNS) {
      expect(migrationColumns.has(column), `migration is missing column "${column}"`).toBe(true);
    }
    expect(migrationColumns.size).toBe(EXPECTED_COLUMNS.length);
  });

  it("every migration column appears in Row, Insert and Update", () => {
    for (const column of migrationColumns.keys()) {
      const rowField = new RegExp(`^\\s*${column}:`, "m");
      expect(rowField.test(typesBlock), `Row is missing "${column}"`).toBe(true);

      const insertOrUpdateField = new RegExp(`^\\s*${column}\\??:`, "m");
      expect(insertOrUpdateField.test(typesBlock), `Insert/Update missing "${column}"`).toBe(
        true,
      );
    }
  });

  it("nullability in Row matches `not null` in the migration", () => {
    const rowSection = typesBlock.slice(
      typesBlock.indexOf("Row: {"),
      typesBlock.indexOf("Insert: {"),
    );

    for (const [column, { notNull }] of migrationColumns) {
      const fieldMatch = new RegExp(`^\\s*${column}:\\s*(.+)$`, "m").exec(rowSection);
      expect(fieldMatch, `Row field "${column}" not found`).not.toBeNull();
      const isNullable = /\|\s*null/.test(fieldMatch![1]!);
      expect(
        isNullable,
        `Row.${column} nullability disagrees with the migration (not null: ${String(notNull)})`,
      ).toBe(!notNull);
    }
  });

  it("a column with a default (or nullable) is optional in Insert", () => {
    const insertSection = typesBlock.slice(
      typesBlock.indexOf("Insert: {"),
      typesBlock.indexOf("Update: {"),
    );

    for (const [column, { hasDefault, notNull }] of migrationColumns) {
      const fieldMatch = new RegExp(`^\\s*${column}(\\??):`, "m").exec(insertSection);
      expect(fieldMatch, `Insert field "${column}" not found`).not.toBeNull();
      const isOptional = fieldMatch![1] === "?";
      const shouldBeOptional = hasDefault || !notNull;
      expect(
        isOptional,
        `Insert.${column} optionality disagrees with the migration (hasDefault: ${String(hasDefault)}, notNull: ${String(notNull)})`,
      ).toBe(shouldBeOptional);
    }
  });

  it("the foreign key relationship matches the migration's reference", () => {
    expect(migration).toMatch(
      /session_id uuid not null references public\.sessions\(id\) on delete cascade/,
    );
    expect(typesBlock).toContain('foreignKeyName: "review_comments_session_id_fkey"');
    expect(typesBlock).toContain('referencedRelation: "sessions"');
    expect(typesBlock).toContain('referencedColumns: ["id"]');
  });

  it("every `references` in the migration has a matching index or is the primary key", () => {
    expect(migration).toMatch(/references public\.sessions\(id\)/);
    expect(migration).toContain(
      "create index review_comments_session_id_idx\n  on public.review_comments (session_id);",
    );
  });
});
