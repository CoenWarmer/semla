/**
 * Hover, references, rename, and diagnostics, backed by a real language
 * server.
 *
 * Sibling to `definition-provider.ts`, and built the same way: one config
 * object, registered once against refs for the editor's lifetime, so the
 * provider Monaco holds stays stable while the callbacks it calls through
 * stay current. See `lsp-host.ts` for what runs behind the requests this
 * makes, and `lsp-translate.ts` for the pure LSP-to-Monaco conversions this
 * file has no test of its own for the same reason `definition-provider.ts`
 * does not — importing `monaco-editor` wants a DOM this repository's tests
 * do not run with.
 *
 * Diagnostics are the one thing here that is not a Monaco provider answering
 * a gesture: the server publishes them unprompted, over the SSE stream
 * `subscribeDiagnostics` wraps, for every open document in a project at once.
 * A path with no model yet — a diagnostic can arrive for a file the operator
 * has not opened — is held in `pending` until `applyDiagnostics` is asked
 * about it, which `code-editor.tsx` does from the same effect that gives a
 * newly opened path its model.
 */

import type { monaco as Monaco } from "./monaco-setup";
import { monaco } from "./monaco-setup";
import { ensureModel, uriForWorkspacePath, type ReadFile } from "./definition-provider";
import {
  diagnosticToMarker,
  hoverContentsToMarkdown,
  toMonacoRange,
  type LspDiagnostic,
  type LspHover,
  type LspRange,
  type LspRenameFile,
  type LspReferenceLocation,
} from "./lsp-translate";

export type LspRequest = {
  path: string;
  project: string;
  line: number;
  character: number;
};

export type LspPrepareRenameAnswer =
  | LspRange
  | { range: LspRange; placeholder?: string }
  | null;

export type LspProviderConfig = {
  /** The file currently in the editor, so a request can be attributed. */
  current: () => { path: string; project: string } | null;
  languages: readonly string[];
  toWorkspacePath: (project: string, path: string) => string;
  readFile: ReadFile;
  /** A resolution that cannot be acted on, for the panel's notice bar. */
  onNotice: (message: string) => void;
  requestHover: (request: LspRequest) => Promise<LspHover | null>;
  requestReferences: (request: LspRequest) => Promise<LspReferenceLocation[] | null>;
  prepareRename: (request: LspRequest) => Promise<LspPrepareRenameAnswer>;
  requestRename: (
    request: LspRequest & { newName: string },
  ) => Promise<{ files: LspRenameFile[] } | null>;
  /**
   * Buffer sync, called directly by `code-editor.tsx` rather than through
   * anything registered here — these are LSP notifications, not answers to a
   * Monaco gesture, so there is no provider interface for them to implement.
   *
   * One function for both opening and editing: `review/lsp/notify/route.ts`
   * decides which of `didOpen`/`didChange` a document actually needs from
   * whether the host has already seen it, not from which the caller says —
   * so there is nothing for this side of the wire to get right or wrong by
   * calling it at the wrong moment.
   */
  notifySync: (path: string, project: string, text: string) => void;
  notifyClose: (path: string, project: string) => void;
  /**
   * Attach to the project's diagnostics. Returns an unsubscribe — the caller
   * owns the SSE connection this wraps, opened once per project rather than
   * once per editor instance.
   */
  subscribeDiagnostics: (
    onDiagnostics: (path: string, diagnostics: LspDiagnostic[]) => void,
  ) => () => void;
};

export type LspProviderHandle = Monaco.IDisposable & {
  /** Set markers for `workspacePath` from whatever diagnostics are already known. */
  applyDiagnostics: (workspacePath: string) => void;
};

/** Whether `model` is the file the panel currently has open. */
function isCurrentModel(
  model: Monaco.editor.ITextModel,
  config: LspProviderConfig,
): { path: string; project: string } | null {
  const current = config.current();
  if (!current) return null;

  const openUri = uriForWorkspacePath(config.toWorkspacePath(current.project, current.path));
  return model.uri.toString() === openUri.toString() ? current : null;
}

export function registerLspProviders(config: LspProviderConfig): LspProviderHandle {
  const pending = new Map<string, LspDiagnostic[]>();

  const applyDiagnostics = (workspacePath: string) => {
    const diagnostics = pending.get(workspacePath);
    if (!diagnostics) return;

    const model = monaco.editor.getModel(uriForWorkspacePath(workspacePath));
    if (!model) return;

    monaco.editor.setModelMarkers(model, "lsp", diagnostics.map(diagnosticToMarker));
  };

  const unsubscribeDiagnostics = config.subscribeDiagnostics((path, diagnostics) => {
    pending.set(path, diagnostics);
    applyDiagnostics(path);
  });

  const hoverProvider: Monaco.languages.HoverProvider = {
    async provideHover(model, position) {
      const current = isCurrentModel(model, config);
      if (!current) return null;

      const hover = await config.requestHover({
        character: position.column,
        line: position.lineNumber,
        path: current.path,
        project: current.project,
      });
      if (!hover) return null;

      return {
        contents: [{ value: hoverContentsToMarkdown(hover.contents) }],
        range: hover.range ? toMonacoRange(hover.range) : undefined,
      };
    },
  };

  const referenceProvider: Monaco.languages.ReferenceProvider = {
    async provideReferences(model, position) {
      const current = isCurrentModel(model, config);
      if (!current) return null;

      const locations = await config.requestReferences({
        character: position.column,
        line: position.lineNumber,
        path: current.path,
        project: current.project,
      });
      if (!locations) return null;

      const resolved = await Promise.all(
        locations.map(async (location) => {
          const target = await ensureModel(location.path, config.readFile);
          if (!target) return null;
          return { range: toMonacoRange(location.range), uri: target.uri };
        }),
      );

      return resolved.filter((location): location is Monaco.languages.Location => location !== null);
    },
  };

  /**
   * `resolveRenameLocation` is the "prepare" step: what Monaco's rename
   * widget selects and shows before the operator has typed anything. A null
   * answer — punctuation, a keyword, nothing the server can rename — has to
   * throw rather than return, which is how this provider interface spells
   * "not here" (`Rejection` widens to `Error | undefined`, but Monaco calls
   * it by inspecting a thrown error's message rather than the field).
   */
  const renameProvider: Monaco.languages.RenameProvider = {
    async provideRenameEdits(model, position, newName) {
      const current = isCurrentModel(model, config);
      if (!current) throw new Error("This file has no session to rename in.");

      const answer = await config.requestRename({
        character: position.column,
        line: position.lineNumber,
        newName,
        path: current.path,
        project: current.project,
      });
      if (!answer || answer.files.length === 0) {
        throw new Error("Nothing to rename here.");
      }

      const edits: Monaco.languages.IWorkspaceTextEdit[] = [];
      for (const file of answer.files) {
        const target = await ensureModel(file.path, config.readFile);
        if (!target) {
          config.onNotice(`Unable to open ${file.path} to apply its rename edits.`);
          continue;
        }
        for (const edit of file.edits) {
          edits.push({
            resource: target.uri,
            textEdit: { range: toMonacoRange(edit.range), text: edit.newText },
            versionId: undefined,
          });
        }
      }

      if (edits.length === 0) throw new Error("Unable to apply this rename anywhere.");
      return { edits };
    },

    async resolveRenameLocation(model, position) {
      const current = isCurrentModel(model, config);
      if (!current) throw new Error("This file has no session to rename in.");

      const answer = await config.prepareRename({
        character: position.column,
        line: position.lineNumber,
        path: current.path,
        project: current.project,
      });
      if (!answer) throw new Error("This is not something that can be renamed.");

      const range = "range" in answer ? answer.range : answer;
      const monacoRange = toMonacoRange(range);
      const placeholder =
        "placeholder" in answer && answer.placeholder
          ? answer.placeholder
          : model.getValueInRange(monacoRange);

      return { range: monacoRange, text: placeholder };
    },
  };

  const disposables = config.languages.flatMap((language) => [
    monaco.languages.registerHoverProvider(language, hoverProvider),
    monaco.languages.registerReferenceProvider(language, referenceProvider),
    monaco.languages.registerRenameProvider(language, renameProvider),
  ]);

  return {
    applyDiagnostics,
    dispose() {
      for (const disposable of disposables) disposable.dispose();
      unsubscribeDiagnostics();
      pending.clear();
    },
  };
}
