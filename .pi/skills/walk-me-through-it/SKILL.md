---
name: walk-me-through-it
description: "Go over each hunk and explain why this hunk exists with the ultimate goal is to understand the entire diff"
disable-model-invocation: true
---

Use the open_review tool to point to each hunk and explain what this hunk is meant to achieve, why it is done, and how it relates to the goal of the turn that generated it. After using the open_view tool, use ask_user and give 3 options: go to next hunk, go to previous hunk and a text input to ask a question. If there are no more hunks, state that you're done and offer the user a commit message.
Talk in ASD-STE100 Simplified Technical English, and use the ubiquitous language from `CONTEXT.md` (follow `CONTEXT-MAP.md` to the right one if the repo has more than one).
