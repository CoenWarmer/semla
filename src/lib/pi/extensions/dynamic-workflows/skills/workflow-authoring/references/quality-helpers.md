# Verify and judge

Keep work IDs outside helper results that may omit failed agents.

| Call | Contract |
| --- | --- |
| `verify(item, { reviewers: number, threshold: number, lens: string | string[], tier?: string })` | Defaults: 2 reviewers, inclusive `0.5`, one lens or a cycled array. Returns `{ real, realCount, total, votes }`. Failed reviewers are omitted; successful votes are the denominator; zero survivors means `real: false`. `tier` selects the reviewer subagents' model exactly like `agent()`'s: required when called outside any declared phase, and displaced (with a logged override) by the phase's declared tier inside one. |
| `judgePanel(attempts, { judges: number, rubric: string, tier?: string })` | Defaults: 3 judges and `"overall quality and correctness"`. Failed judgments are omitted. Returns the highest mean `{ index, attempt, score, judgments }`; input order wins ties; empty input returns `undefined`. `tier` selects the judge subagents' model exactly like `agent()`'s: required when called outside any declared phase, and displaced (with a logged override) by the phase's declared tier inside one. |
