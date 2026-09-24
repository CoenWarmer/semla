"use client";

import { useState } from "react";
import type { AskUserPayload } from "@/lib/pi/bridge/ask-user-bridge";
import { Input } from "@/components/ui/input";
import {
  Questionnaire,
  QuestionnaireActions,
  QuestionnaireChoice,
  QuestionnaireChoiceDescription,
  QuestionnaireChoices,
  QuestionnaireDescription,
  QuestionnaireInput,
  QuestionnaireItem,
  QuestionnaireNext,
  QuestionnairePrevious,
  QuestionnaireProgress,
  QuestionnaireSubmit,
  QuestionnaireTitle,
} from "@/components/ui/questionnaire";

interface AskUserDialogProps {
  payload: AskUserPayload;
  sessionId: string;
  onDismiss: () => void;
}

export function AskUserDialog({ payload, sessionId, onDismiss }: AskUserDialogProps) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The free-text value typed into an `allowFreeText` option's nested input,
  // keyed by question id. Read on submit only for the option that is both
  // flagged and currently checked — see handleSubmit.
  const [freeText, setFreeText] = useState<Record<string, string>>({});

  // Which option value is checked right now, per question. Drives whether
  // the nested free-text input is shown — formData alone only tells us that
  // on submit, but the input has to appear/disappear as the user clicks.
  const [checkedValue, setCheckedValue] = useState<Record<string, string | string[]>>({});

  const items = payload.questions.map((q) => ({
    name: q.id,
    required: q.type !== "text",
  }));

  const freeTextOptionValue = (q: AskUserPayload["questions"][number]): string | undefined =>
    q.options?.find((opt) => opt.allowFreeText)?.value;

  const isFreeTextChecked = (q: AskUserPayload["questions"][number]): boolean => {
    const freeValue = freeTextOptionValue(q);
    if (freeValue === undefined) return false;
    const current = checkedValue[q.id];
    return q.type === "multiple" ? (current ?? []).includes(freeValue) : current === freeValue;
  };

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    const formData = new FormData(e.currentTarget);
    const answers: Record<string, string> = {};

    for (const q of payload.questions) {
      const freeValue = freeTextOptionValue(q);
      const typed = (freeText[q.id] ?? "").trim();

      if (q.type === "multiple") {
        const values = formData.getAll(q.id) as string[];
        const resolved = values.map((value) => (value === freeValue ? typed : value));
        answers[q.id] = resolved.join(", ");
      } else {
        const value = (formData.get(q.id) as string | null) ?? "";
        answers[q.id] = value === freeValue ? typed : value;
      }
    }

    try {
      const response = await fetch(`/api/sessions/${sessionId}/answer-question`, {
        body: JSON.stringify({ answers }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Failed to submit answer.");
      }

      onDismiss();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setSubmitting(false);
    }
  };

  const isMultiItem = payload.questions.length > 1;

  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3 shadow-sm">
      <Questionnaire
        className="gap-3"
        items={items}
        shortcuts="letters"
        onSubmit={handleSubmit}
      >
        {isMultiItem && <QuestionnaireProgress className="text-xs" />}

        {payload.questions.map((q) => (
          <QuestionnaireItem key={q.id} className="gap-2.5" name={q.id} multiple={q.type === "multiple"} required={q.type !== "text"}>
            <QuestionnaireTitle className="text-sm font-medium">{q.question}</QuestionnaireTitle>
            {q.description && (
              <QuestionnaireDescription className="text-xs">{q.description}</QuestionnaireDescription>
            )}

            {q.type === "text" ? (
              <QuestionnaireInput className="min-h-0 h-8 text-sm px-3 rounded-md" placeholder="Type your answer…" />
            ) : (
              <QuestionnaireChoices className="gap-1.5">
                {(q.options ?? []).map((opt) => (
                  <QuestionnaireChoice
                    key={opt.value}
                    className="min-h-0 px-3 py-2 text-xs rounded-lg"
                    value={opt.value}
                    onChange={(e) => {
                      setCheckedValue((prev) => {
                        if (q.type === "multiple") {
                          const current = (prev[q.id] as string[] | undefined) ?? [];
                          const next = e.target.checked
                            ? [...current, opt.value]
                            : current.filter((value) => value !== opt.value);
                          return { ...prev, [q.id]: next };
                        }
                        return { ...prev, [q.id]: opt.value };
                      });
                    }}
                  >
                    {opt.label}
                    {opt.description && (
                      <QuestionnaireChoiceDescription className="text-xs">
                        {opt.description}
                      </QuestionnaireChoiceDescription>
                    )}
                    {opt.allowFreeText && isFreeTextChecked(q) && (
                      // z-20 lifts the input above the choice's own absolutely
                      // positioned ChoiceInput overlay (z-10, see
                      // questionnaire.tsx), and stopPropagation on the input
                      // itself keeps a click here from re-toggling that radio.
                      <Input
                        className="relative z-20 h-7 mt-1 text-xs"
                        placeholder="Type your answer…"
                        value={freeText[q.id] ?? ""}
                        onChange={(e) => setFreeText((prev) => ({ ...prev, [q.id]: e.target.value }))}
                        onClick={(e) => e.stopPropagation()}
                      />
                    )}
                  </QuestionnaireChoice>
                ))}
              </QuestionnaireChoices>
            )}
          </QuestionnaireItem>
        ))}

        {error && (
          <p className="text-xs text-destructive">{error}</p>
        )}

        <QuestionnaireActions className="min-h-0 gap-1.5">
          {isMultiItem && <QuestionnairePrevious size="sm" />}
          {isMultiItem ? (
            <QuestionnaireNext size="sm" />
          ) : (
            <QuestionnaireSubmit size="sm" disabled={submitting}>
              {submitting ? "Sending…" : "Submit"}
            </QuestionnaireSubmit>
          )}
          {isMultiItem && <QuestionnaireSubmit size="sm" disabled={submitting}>
            {submitting ? "Sending…" : "Submit"}
          </QuestionnaireSubmit>}
        </QuestionnaireActions>
      </Questionnaire>
    </div>
  );
}
