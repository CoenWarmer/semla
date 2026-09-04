import { describe, expect, it } from "vitest";

import {
  shouldPlayDoneSound,
  shouldPlayQuestionSound,
  type SoundCueState,
} from "@/lib/session-sound-cue";

const idle: SoundCueState = { hasPendingQuestion: false, isActive: false };

describe("shouldPlayQuestionSound", () => {
  it("plays when a question arrives while unfocused", () => {
    expect(
      shouldPlayQuestionSound(
        idle,
        { ...idle, hasPendingQuestion: true },
        false,
      ),
    ).toBe(true);
  });

  it("does not play while focused", () => {
    expect(
      shouldPlayQuestionSound(
        idle,
        { ...idle, hasPendingQuestion: true },
        true,
      ),
    ).toBe(false);
  });

  it("does not re-fire while the question is already pending", () => {
    const pending: SoundCueState = { ...idle, hasPendingQuestion: true };
    expect(shouldPlayQuestionSound(pending, pending, false)).toBe(false);
  });

  it("does not fire when the question is answered (true -> false)", () => {
    expect(
      shouldPlayQuestionSound(
        { ...idle, hasPendingQuestion: true },
        idle,
        false,
      ),
    ).toBe(false);
  });
});

describe("shouldPlayDoneSound", () => {
  it("plays when a turn finishes while unfocused", () => {
    expect(
      shouldPlayDoneSound({ ...idle, isActive: true }, idle, false),
    ).toBe(true);
  });

  it("does not play while focused", () => {
    expect(
      shouldPlayDoneSound({ ...idle, isActive: true }, idle, true),
    ).toBe(false);
  });

  it("does not play when a turn starts (false -> true)", () => {
    expect(
      shouldPlayDoneSound(idle, { ...idle, isActive: true }, false),
    ).toBe(false);
  });

  it("defers to the question sound when the turn ends with a question pending", () => {
    expect(
      shouldPlayDoneSound(
        { ...idle, isActive: true },
        { isActive: false, hasPendingQuestion: true },
        false,
      ),
    ).toBe(false);
  });

  it("does not re-fire while already idle", () => {
    expect(shouldPlayDoneSound(idle, idle, false)).toBe(false);
  });
});
