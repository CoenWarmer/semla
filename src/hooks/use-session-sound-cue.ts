"use client";

import { useEffect, useRef } from "react";

import {
  shouldPlayDoneSound,
  shouldPlayQuestionSound,
  type SoundCueState,
} from "@/lib/session-sound-cue";

/**
 * Play question.mp3 / done.mp3 when this session's state changes while its
 * tab or window is not focused.
 *
 * Focus is read from `document.hasFocus()` rather than tracked as React
 * state: the transitions this hook cares about (a question arriving, a turn
 * ending) are driven by props changing, and reading focus at that moment is
 * simpler and cheaper than subscribing every session page to focus/blur
 * events just to re-render on them.
 */
export function useSessionSoundCue(state: SoundCueState): void {
  const previousRef = useRef<SoundCueState>(state);
  const questionAudioRef = useRef<HTMLAudioElement | null>(null);
  const doneAudioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    const previous = previousRef.current;
    previousRef.current = state;

    // SSR-safe and quiet in non-browser test environments: nothing here runs
    // without a `document`.
    if (typeof document === "undefined") return;
    const focused = document.hasFocus();

    if (shouldPlayQuestionSound(previous, state, focused)) {
      questionAudioRef.current ??= new Audio("/sounds/question.mp3");
      void questionAudioRef.current.play().catch(() => {
        // Autoplay can be blocked before the user has interacted with the
        // page at all; nothing to recover from here.
      });
      return;
    }

    if (shouldPlayDoneSound(previous, state, focused)) {
      doneAudioRef.current ??= new Audio("/sounds/done.mp3");
      void doneAudioRef.current.play().catch(() => {});
    }
  }, [state]);
}
