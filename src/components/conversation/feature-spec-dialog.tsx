"use client";

/**
 * The form `capture_feature_spec` renders: three fixed textareas — goal,
 * functional requirements, non-functional requirements — submitted to
 * /api/sessions/[id]/feature-spec-answer.
 *
 * Structurally this is AskUserDialog with a fixed field set instead of a
 * per-call question array, which is why it does not reuse the `Questionnaire`
 * primitive: that component is built around a list of items to step through,
 * and this is three always-visible fields submitted together.
 */

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { FeatureSpecAnswers } from "@/lib/pi/bridge/feature-spec-bridge";

interface FeatureSpecDialogProps {
  sessionId: string;
  onDismiss: () => void;
}

const FIELDS: { key: keyof FeatureSpecAnswers; label: string; placeholder: string }[] = [
  {
    key: "goal",
    label: "Overarching goal",
    placeholder: "What is this feature for, and what does success look like?",
  },
  {
    key: "functionalRequirements",
    label: "Functional requirements",
    placeholder: "What must the feature do?",
  },
  {
    key: "nonFunctionalRequirements",
    label: "Non-functional requirements",
    placeholder: "Performance, reliability, security, and other constraints.",
  },
];

export function FeatureSpecDialog({ sessionId, onDismiss }: FeatureSpecDialogProps) {
  const [values, setValues] = useState<FeatureSpecAnswers>({
    functionalRequirements: "",
    goal: "",
    nonFunctionalRequirements: "",
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      const response = await fetch(
        `/api/sessions/${sessionId}/feature-spec-answer`,
        {
          body: JSON.stringify(values),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        },
      );

      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Failed to submit feature spec.");
      }

      onDismiss();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setSubmitting(false);
    }
  };

  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3 shadow-sm">
      <form className="flex flex-col gap-3" onSubmit={handleSubmit}>
        <p className="text-sm font-medium">Feature spec</p>

        {FIELDS.map((field) => (
          <div className="flex flex-col gap-1" key={field.key}>
            <label className="text-xs font-medium text-muted-foreground" htmlFor={`feature-spec-${field.key}`}>
              {field.label}
            </label>
            <Textarea
              className="min-h-20 text-sm"
              id={`feature-spec-${field.key}`}
              placeholder={field.placeholder}
              value={values[field.key]}
              onChange={(e) =>
                setValues((prev) => ({ ...prev, [field.key]: e.target.value }))
              }
            />
          </div>
        ))}

        {error && <p className="text-xs text-destructive">{error}</p>}

        <div className="flex justify-end">
          <Button disabled={submitting} size="sm" type="submit">
            {submitting ? "Sending…" : "Submit"}
          </Button>
        </div>
      </form>
    </div>
  );
}
