/**
 * The one test in this bridge that talks to a real `tsc --lsp` process rather
 * than a fake `LspConnection` — everything else in `lsp-host.test.ts` is
 * deliberately faked, for the reasons given there. This exists because a fake
 * cannot catch a wrong assumption about the real protocol, and this bridge
 * already had one: TS 7's `initialize` response advertises `diagnosticProvider`
 * rather than ever sending `textDocument/publishDiagnostics` unprompted, which
 * only spawning the real binary and watching what it actually sent surfaced —
 * see the doc comment on `pullDiagnostics` in `lsp-host.ts`.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HoverRequest } from "vscode-languageserver-protocol/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  documentUri,
  killLspHost,
  openOrChangeDocument,
  pullDiagnostics,
  registerLspHost,
  spawnLspConnection,
} from "@/lib/pi/browser-lsp/lsp-host";
import { ensureLanguageServersOnPath } from "@/lib/pi/runtime/language-servers";

const SOURCE = `/** Adds two numbers. */
export function add(a: number, b: number): number {
  return a + b;
}

const bad: number = "oops";
`;

let root: string;

beforeAll(async () => {
  // The shim this spawns by bare name — see language-servers.ts — is only on
  // PATH once this has run; `instrumentation.ts` does it for the real server,
  // and nothing does it for a Vitest process.
  ensureLanguageServersOnPath();

  root = await mkdtemp(join(tmpdir(), "semla-lsp-test-"));
  await writeFile(
    join(root, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { strict: true, target: "ES2017" }, include: ["*.ts"] }),
  );
  await writeFile(join(root, "a.ts"), SOURCE);
});

afterAll(async () => {
  killLspHost(root);
  await rm(root, { force: true, recursive: true });
});

describe("a real tsc --lsp process", () => {
  it(
    "answers a hover and reports the file's diagnostics",
    async () => {
      const connection = await spawnLspConnection(root);
      const host = registerLspHost(root, connection);
      const uri = documentUri(join(root, "a.ts"));

      openOrChangeDocument(host, uri, "typescript", SOURCE);

      // `add` on line 2 (one-based) — LSP's zero-based `{ line: 1, character: 17 }`.
      const hover = await connection.sendRequest(HoverRequest.method, {
        position: { character: 17, line: 1 },
        textDocument: { uri },
      });
      expect(JSON.stringify(hover)).toContain("Adds two numbers");

      // `openOrChangeDocument` already fired a pull in the background; this
      // one is awaited, so the assertion below is not racing it.
      await pullDiagnostics(host, uri);

      // `message` is typed `string | MarkupContent` — vscode-languageserver-types
      // widened it in 3.18.0 for a client capability this bridge does not
      // declare, so TS 7 has no reason to send anything but the plain string
      // it always has.
      const diagnostics = host.diagnostics.get(uri) ?? [];
      const messages = diagnostics.map((diagnostic) => diagnostic.message);
      expect(
        messages.some(
          (message) => typeof message === "string" && message.includes("not assignable"),
        ),
      ).toBe(true);
    },
    15_000,
  );
});
