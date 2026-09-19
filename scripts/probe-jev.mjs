/**
 * Live probe of OpenRouter's alpha Decisions API (`~typesafe/jev-latest`).
 *
 * Not run in CI. Its purpose is to record the real response shape, because
 * `docs/plans/jev-agent-gating.md` §4 infers a `probabilities` map on `choice`
 * answers from an undocumented part of the model page. Everything downstream
 * (the threshold logic in `jev-gate.ts`) is only trustworthy if that map is
 * really there, so it is established by probing rather than by documentation —
 * the same discipline `code-index/credentials.ts` records for the embedding
 * models absent from `/api/v1/models`.
 *
 *   node scripts/probe-jev.mjs
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function readKey() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  const authPath = join(homedir(), ".semla", "agent", "auth.json");
  const parsed = JSON.parse(readFileSync(authPath, "utf-8"));
  const entry = parsed.openrouter;
  if (typeof entry === "string") return entry;
  return entry?.apiKey ?? entry?.api_key ?? entry?.key ?? null;
}

const key = readKey();
if (!key) {
  console.error("No OpenRouter key found (env or ~/.semla/agent/auth.json).");
  process.exit(1);
}

const body = {
  model: "~typesafe/jev-latest",
  state: {
    user_prompt: "Fix the failing test in src/lib/pi/runtime/agent-dir.test.ts",
    candidate_tools: {
      read: "Read the contents of a file",
      bash: "Execute a bash command",
      workflow: "Delegate work to subagents",
      wiki_capture_source: "Capture a URL or file into the wiki",
      capture_feature_spec: "Render a form to capture a feature specification",
    },
    candidate_skills: {
      supabase: "Any task involving Supabase products or client libraries",
      "workflow-authoring": "Writing or editing JavaScript workflow scripts",
    },
  },
  questions: {
    tools: {
      type: "choice",
      instructions: "Which tool does this turn need most?",
      criteria: {
        read: "The turn needs to read file contents",
        bash: "The turn needs to run a shell command",
        workflow: "The turn needs to fan work out to subagents",
        wiki_capture_source: "The turn needs to capture a source into the wiki",
        capture_feature_spec: "The turn needs to capture a feature specification",
      },
    },
    skills: {
      type: "choice",
      instructions: "Which skill is relevant to this turn?",
      criteria: {
        supabase: "The turn involves Supabase",
        "workflow-authoring": "The turn involves authoring workflow scripts",
      },
    },
    needs_mcp: {
      type: "noul",
      instructions: "Does this turn need MCP or browser capability?",
      criteria: {
        true: "The turn requires browser automation or an external MCP server",
        false: "The turn can be completed with local file and shell access",
      },
    },
    complexity: {
      type: "score",
      instructions: "How complex is this turn?",
      criteria: ["trivial", "small", "medium", "large"],
    },
  },
};

const started = Date.now();
const response = await fetch("https://openrouter.ai/api/alpha/decisions", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify(body),
});
const elapsedMs = Date.now() - started;
const text = await response.text();

console.log(`HTTP ${response.status} ${response.statusText} in ${elapsedMs}ms`);
console.log("--- headers ---");
for (const [k, v] of response.headers.entries()) {
  if (/^(content-type|x-ratelimit|x-openrouter)/i.test(k)) console.log(`${k}: ${v}`);
}
console.log("--- body ---");
try {
  console.log(JSON.stringify(JSON.parse(text), null, 2));
} catch {
  console.log(text);
}
