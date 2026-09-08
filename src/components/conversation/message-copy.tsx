"use client";

/**
 * Copying a message's text.
 *
 * Shared by both roles: a user prompt renders its own row in
 * `message-edit.tsx` and an assistant reply renders one in the conversation,
 * and the button has to look and behave the same in each.
 *
 * The text copied is the message as it was written — the raw markdown, not the
 * rendered output. That is what is useful: a prompt gets pasted into another
 * prompt, and an answer gets pasted somewhere that will render it again.
 */

import { CheckIcon, CopyIcon } from "lucide-react";
import { useRef, useState } from "react";

import { cn } from "@/lib/utils";

/** How long the tick stays before it turns back into the clipboard. */
const CONFIRM_MS = 1_200;

export function CopyMessageButton({
  className,
  text,
}: {
  className?: string;
  text: string;
}) {
  const [copied, setCopied] = useState(false);
  const revert = useRef<ReturnType<typeof setTimeout> | null>(null);

  const copy = () => {
    // Cleared first: copying twice quickly would otherwise let the first
    // timer turn the tick off while the second copy is still fresh.
    if (revert.current) clearTimeout(revert.current);

    void navigator.clipboard.writeText(text).then(
      () => {
        setCopied(true);
        revert.current = setTimeout(() => setCopied(false), CONFIRM_MS);
      },
      () => {
        // Denied, or an insecure context. Saying nothing is better than a
        // tick that claims something was copied when it was not.
        setCopied(false);
      },
    );
  };

  return (
    <button
      className={cn(
        "shrink-0 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover/message:opacity-100",
        className,
      )}
      onClick={copy}
      title={copied ? "Copied" : "Copy this message"}
      type="button"
    >
      {copied ? (
        <CheckIcon className="size-3.5" />
      ) : (
        <CopyIcon className="size-3.5" />
      )}
      <span className="sr-only">{copied ? "Copied" : "Copy this message"}</span>
    </button>
  );
}
