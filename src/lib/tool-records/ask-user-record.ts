/**
 * Reading the questions and answers back out of an `ask_user` tool result.
 *
 * The tool's own result text is the only place the pairing survives into the
 * transcript. `ask-user.ts` returns
 *
 *     <question>
 *     → <answer>
 *
 * per question, blocks joined by a blank line, and its structured `details`
 * (the raw answers object) is not persisted — `getParams` in transcript.ts
 * keeps only scalar arguments, so the `questions` array is dropped there too.
 * So this parses the text, and is deliberately tolerant rather than strict:
 * an answer the user typed with newlines in it should not lose everything
 * after the first one.
 *
 * The one thing it cannot recover is a blank line *inside* a free-text answer,
 * which is indistinguishable from the separator between two pairs. Those
 * collapse to a single newline.
 */

const ANSWER_PREFIX = "→ ";

export type AskUserPair = { answer: string; question: string };

/**
 * Pairs, in the order they were asked. Empty when the text is not in the
 * expected shape at all — a cancellation message, say — which is the caller's
 * cue to fall back to showing the raw text.
 */
export function parseAskUserResult(text: string | undefined): AskUserPair[] {
  if (!text?.trim()) return [];

  const pairs: AskUserPair[] = [];
  let question: string[] = [];
  let answer: string[] | null = null;

  const flush = () => {
    if (answer === null) return;
    pairs.push({
      answer: answer.join("\n").trim(),
      question: question.join("\n").trim(),
    });
    question = [];
    answer = null;
  };

  for (const line of text.split("\n")) {
    if (line.startsWith(ANSWER_PREFIX)) {
      // A second arrow without an intervening blank line still starts a new
      // pair: the question lines collected since the last flush belong to it.
      flush();
      answer = [line.slice(ANSWER_PREFIX.length)];
      continue;
    }

    if (answer === null) {
      question.push(line);
      continue;
    }

    // Blank line after an answer ends the pair; anything else continues it.
    if (line.trim() === "") flush();
    else answer.push(line);
  }

  flush();

  return pairs.filter((pair) => pair.question !== "" || pair.answer !== "");
}
