/**
 * A pull request Semla watched a tool call create.
 *
 * Detection only, never creation, and deliberately narrow: `gh pr create`
 * prints the new PR's url on stdout as its last line, and that url is the
 * whole record. Nothing here calls the GitHub API — a PR number is a fact
 * observed in a shell transcript, not a resource this app owns.
 *
 * Known and accepted gaps, listed rather than guessed at:
 *  - a PR opened in a browser (`gh pr create --web`, or the link `git push`
 *    prints) is not detected; no url is emitted to observe.
 *  - `gh pr create` whose output was swallowed (`>/dev/null`) is not detected.
 *  - a PR created by a script the agent invoked is detected only if the url
 *    reaches the tool result text.
 * A missing PR record is recoverable. A fabricated one is not.
 */

export interface DetectedPr {
  url: string;
  number: number | null;
  repo: string | null;
}

/** Requires "gh", "pr" and "create" to all appear, in that command. */
const GH_PR_CREATE = /\bgh\b[\s\S]*\bpr\b[\s\S]*\bcreate\b/;

/** `https://github.com/<owner>/<repo>/pull/<digits>`, greedy on neither side. */
const PR_URL = /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/g;

/**
 * Detect PRs a `gh pr create` call surfaced.
 *
 * `command` gates whether this is even looked at — the intent has to be in
 * the command itself, or `gh pr list` output, a grep hit, or a url the agent
 * merely echoed would all be mistaken for a created PR. `output` (and
 * `command`, so `gh pr create ... && echo <url>` still works) is then scanned
 * for every matching url, deduped and in the order they appeared.
 *
 * Hosts other than github.com are not matched. Enterprise hosts are out of
 * scope, and saying so beats a regex that matches any `/pull/<n>`.
 */
export function detectPullRequests(input: {
  command: string | null;
  output: string | null;
}): DetectedPr[] {
  if (!input.command || !GH_PR_CREATE.test(input.command)) return [];

  const haystack = `${input.command}\n${input.output ?? ""}`;
  const seen = new Set<string>();
  const results: DetectedPr[] = [];

  for (const match of haystack.matchAll(PR_URL)) {
    const url = match[0];
    if (seen.has(url)) continue;
    seen.add(url);
    results.push({
      number: Number(match[3]),
      repo: `${match[1]}/${match[2]}`,
      url,
    });
  }

  return results;
}
