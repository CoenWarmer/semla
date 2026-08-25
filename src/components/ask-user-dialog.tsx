"use client";

import { useState } from "react";
import type { AskUserPayload } from "@/lib/pi/ask-user-bridge";
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

  const items = payload.questions.map((q) => ({
    name: q.id,
    required: q.type !== "text",
  }));

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    const formData = new FormData(e.currentTarget);
    const answers: Record<string, string> = {};

    for (const q of payload.questions) {
      if (q.type === "multiple") {
        const values = formData.getAll(q.id) as string[];
        answers[q.id] = values.join(", ");
      } else {
        answers[q.id] = (formData.get(q.id) as string | null) ?? "";
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
                  <QuestionnaireChoice key={opt.value} className="min-h-0 px-3 py-2 text-xs rounded-lg" value={opt.value}>
                    {opt.label}
                    {opt.description && (
                      <QuestionnaireChoiceDescription className="text-xs">
                        {opt.description}
                      </QuestionnaireChoiceDescription>
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
