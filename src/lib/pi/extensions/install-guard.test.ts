/**
 * `npx some-package` downloads and runs it when it is not present, so one tool
 * call can pull arbitrary code onto the machine — and the transcript looks the
 * same as running a local binary.
 *
 * The bar is "would this fetch something new". Blocking anything that mentions
 * npm would make the guard the problem: npx tsc, npx vitest and npx eslint run
 * on nearly every turn here.
 */
import { describe, expect, it } from "vitest";

import {
  inspectBootstrap,
  inspectCommand,
  splitCommands,
} from "./install-guard.ts";

const installed = new Set(["tsc", "vitest", "eslint", "next", "supabase"]);
const isInstalled = (name: string) => installed.has(name);
const check = (command: string) => inspectCommand(command, isInstalled);

describe("commands that fetch something", () => {
  it.each([
    "npx cowsay hello",
    "npx --yes cowsay hello",
    "npx -y create-react-app my-app",
    "npm install left-pad",
    "npm i -D some-linter",
    "npm add another-thing",
    "pnpm add a-package",
    "yarn add a-package",
    "bun add a-package",
    "pip install requests",
    "cargo install ripgrep",
    "go get github.com/some/module",
    "brew install jq",
  ])("blocks %s", (command) => {
    expect(check(command).blocked).toBe(true);
  });

  it("says what to do instead, or the agent just tries again", () => {
    const verdict = check("npx cowsay hello");

    expect(verdict.reason).toContain("ask_user");
    expect(verdict.reason).toContain("cowsay");
  });

  it("catches an install hidden later in a chain", () => {
    expect(check("cd /tmp && ls && npm install left-pad").blocked).toBe(true);
  });

  it("is not fooled by leading environment assignments", () => {
    expect(check("CI=1 FORCE_COLOR=0 npx cowsay hi").blocked).toBe(true);
  });
});

describe("commands that do not", () => {
  it.each([
    "npx tsc --noEmit",
    "npx vitest run",
    "npx eslint src",
    "npx next build",
  ])("allows %s, which runs an installed binary", (command) => {
    expect(check(command).blocked).toBe(false);
  });

  // Restores what package.json already declares; the agent is not choosing to
  // add anything, and this is how the repo's own postinstall works.
  it.each(["npm install", "npm ci", "npm install --prefix .pi/npm"])(
    "allows %s",
    (command) => {
      expect(check(command).blocked).toBe(false);
    },
  );

  it.each([
    "git log --oneline -40",
    "ls -la node_modules",
    "grep -rn 'npm install' README.md",
    "echo 'npx cowsay'",
    "cat package.json",
  ])("allows %s", (command) => {
    expect(check(command).blocked).toBe(false);
  });

  it("allows the whole chain when every part is fine", () => {
    expect(check("cd /Dev/semla && npx tsc && npx vitest run").blocked).toBe(false);
  });
});

describe("splitCommands", () => {
  it("splits on every separator that starts a new command", () => {
    expect(splitCommands("a && b || c ; d | e")).toEqual(["a", "b", "c", "d", "e"]);
  });
});

/**
 * A subagent without wiki tools reproduced them: it called the package's own
 * captureText from a shell and resolved the vault path itself, creating a
 * .llm-wiki inside the repo being oriented. pi-llm-wiki prefers a vault in the
 * working directory over WIKI_HOME from then on, so every later capture went
 * there — three repos ended up with one, and a whole run's work landed
 * somewhere nobody was reading.
 */
describe("hand-built wiki vaults", () => {
  const WIKI_HOME = "/Dev/semla/.semla-wiki";
  const check = (command: string) => inspectCommand(command, isInstalled, WIKI_HOME);

  it.each([
    "mkdir -p /Dev/other-repo/.llm-wiki/wiki/sources",
    "cd /Dev/other-repo && mkdir .llm-wiki",
    "echo '---' > /Dev/other-repo/.llm-wiki/wiki/sources/SRC-1.md",
    "cp -r /tmp/pages /Dev/other-repo/.llm-wiki/wiki",
    "node -e \"const {captureText} = require('pi-llm-wiki'); captureText(p)\" > out",
  ])("blocks %s", (command) => {
    expect(check(command).blocked).toBe(true);
  });

  it("says why the location matters, not just that it is blocked", () => {
    const verdict = check("mkdir -p /Dev/other/.llm-wiki");

    expect(verdict.reason).toContain("takes precedence over WIKI_HOME");
    expect(verdict.reason).toContain(WIKI_HOME);
  });

  // Reading a vault is how anyone works out what went wrong.
  it.each([
    "ls -la /Dev/other-repo/.llm-wiki",
    "cat /Dev/semla/.semla-wiki/.llm-wiki/meta/registry.json",
    "find /Dev/other/.llm-wiki -name '*.md'",
    "grep -rn repo /Dev/other/.llm-wiki/wiki",
  ])("allows %s", (command) => {
    expect(check(command).blocked).toBe(false);
  });

  // The wiki writing to its own vault is the entire point of the wiki.
  it("allows writes inside WIKI_HOME", () => {
    expect(check(`mkdir -p ${WIKI_HOME}/.llm-wiki/wiki/entities`).blocked).toBe(false);
  });

  it("is inert when no wiki home is supplied", () => {
    expect(inspectCommand("mkdir -p /Dev/other/.llm-wiki", isInstalled).blocked).toBe(
      false,
    );
  });
});

/**
 * wiki_bootstrap resolves `params.root ?? ctx.cwd ?? process.cwd()` and never
 * consults WIKI_HOME. A subagent's cwd is the workspace root, so bootstrapping
 * an empty wiki built a vault at /Users/coen/Dev/.llm-wiki — and a vault at cwd
 * wins over WIKI_HOME from then on. That run put fourteen packets in the new
 * vault while synthesis kept reading the old one.
 */
describe("inspectBootstrap", () => {
  const home = "/Users/coen/Dev/semla/.semla-wiki";

  it("refuses a bootstrap with no root, which silently means cwd", () => {
    const verdict = inspectBootstrap(undefined, home);

    expect(verdict.blocked).toBe(true);
    expect(verdict.reason).toContain("workspace root");
  });

  it("refuses a bootstrap aimed anywhere else", () => {
    const verdict = inspectBootstrap("/Users/coen/Dev", home);

    expect(verdict.blocked).toBe(true);
    expect(verdict.reason).toContain("/Users/coen/Dev");
  });

  it("allows one aimed at the Semla vault", () => {
    expect(inspectBootstrap(home, home).blocked).toBe(false);
  });

  it("ignores a trailing slash rather than treating it as a different path", () => {
    expect(inspectBootstrap(`${home}/`, home).blocked).toBe(false);
  });

  it("treats an empty root as the no-root case", () => {
    expect(inspectBootstrap("   ", home).blocked).toBe(true);
  });

  // The refusal has to say where the vault is: a blocked call that leaves the
  // agent guessing gets worked around, which is how this vault acquired a
  // hand-written capture script.
  it("names the vault to use instead", () => {
    expect(inspectBootstrap(undefined, home).reason).toContain(home);
  });
});
