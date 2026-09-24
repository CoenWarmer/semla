---
name: walk-me-through-it
description: "Go over each hunk and explain why this hunk exists with the ultimate goal is to understand the entire diff"
disable-model-invocation: true
---

Explain the changes to the operator.
First look at the entire diff, and decide on the sequence in which every hunk should be explained. A good sequence builds up the mental model of the operator with each passing hunk.

Then, use the `place_review` tool to create comments for all significant hunks describing what this hunk is meant to achieve, why it is done, and how it relates to the goal of the turn that generated it. Hunks that don't require explanation are obvious changes such as updating of import statements, updating of doc blocks or changing of styling variables.

After you created comments using the `place_review` tool, use `open_review` to open the Review Panel on the first comment you created.

Talk in ASD-STE100 Simplified Technical English, and use the ubiquitous language from `CONTEXT.md` (follow `CONTEXT-MAP.md` to the right one if the repo has more than one).
