import { describe, expect, it } from "vitest";

import { parseSlashSkillQuery, slashSkillCommand } from "./slash-skill-query";

describe("parseSlashSkillQuery", () => {
  it("returns an empty query right after the bare prefix", () => {
    expect(parseSlashSkillQuery("/skill:")).toBe("");
  });

  it("returns the partial name typed so far", () => {
    expect(parseSlashSkillQuery("/skill:tdd")).toBe("tdd");
  });

  it("returns null once a space starts the arguments", () => {
    expect(parseSlashSkillQuery("/skill:tdd do the thing")).toBeNull();
  });

  it("returns null once a newline follows the name", () => {
    expect(parseSlashSkillQuery("/skill:tdd\nmore")).toBeNull();
  });

  it("returns null for text with no slash-skill prefix at all", () => {
    expect(parseSlashSkillQuery("hello")).toBeNull();
    expect(parseSlashSkillQuery("/skill")).toBeNull();
    expect(parseSlashSkillQuery("/other:thing")).toBeNull();
  });
});

describe("slashSkillCommand", () => {
  it("builds the literal command text with a trailing space for arguments", () => {
    expect(slashSkillCommand("tdd")).toBe("/skill:tdd ");
  });
});
