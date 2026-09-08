/**
 * Go to Definition for an editor with no language service.
 *
 * Monaco's cmd+click gesture asks a `DefinitionProvider` and nothing else, so
 * the feature does not need the TypeScript language service the review panel
 * deliberately runs without (see monaco-setup.ts) — it needs one function that
 * answers "what is declared at this position". Here that function is a `fetch`
 * to the server, where the TS 7 checker already lives for the code map and the
 * "Explain function" action.
 *
 * **Three things about Monaco make this less obvious than it sounds.**
 *
 * The provider is called on *hover*, not only on click: it is how the gesture
 * decides whether to draw the underline. So it runs on every cmd-hover over
 * every token, which is why the server refuses to resolve non-name tokens
 * cheaply and why identical positions are cached here.
 *
 * A `Location` names a `Uri`, not a path, and Monaco resolves that Uri through
 * its *model registry*. In the standalone editor `StandaloneTextModelService`
 * rejects outright when no model exists for the Uri — the promise Monaco does
 * not catch on the hover path — so a definition in another file must have its
 * model created *before* the location is returned. That is what
 * `ensureModel` is for, and why this module needs to read file contents at
 * all rather than only positions.
 *
 * And a cross-file jump is not Monaco's to make: the panel owns which file is
 * open. `registerEditorOpener` is the seam for that — Monaco calls it instead
 * of trying to swap the model itself, and the panel's own selection state
 * stays the single source of truth for what is on screen.
 */

import type { monaco as Monaco } from "./monaco-setup";
import { monaco } from "./monaco-setup";

/** What the server answers. Mirrors the definition route's shape. */
export type DefinitionAnswer = {
  definition: {
    /** Workspace-relative, or null when outside the workspace entirely. */
    path: string | null;
    line: number;
    name: string;
    external: boolean;
  } | null;
  error?: string;
};

export type DefinitionRequest = {
  /** Project-relative path of the file the cursor is in. */
  path: string;
  project: string;
  line: number;
  character: number;
};

/**
 * A file's text, for building the model a `Location` will point at.
 *
 * Supplied by the caller rather than fetched here so this module does not have
 * to know the file API's shape or a session id, and so the panel's own
 * react-query cache is the one that holds the content.
 */
export type ReadFile = (workspacePath: string) => Promise<string | null>;

export type DefinitionProviderConfig = {
  /** Ask the server. Returns null when the request could not be made at all. */
  resolve: (request: DefinitionRequest) => Promise<DefinitionAnswer | null>;
  readFile: ReadFile;
  /** The file currently in the editor, so a position can be attributed. */
  current: () => { path: string; project: string } | null;
  /**
   * A definition in a different file. The panel opens it; this returns the
   * `Location` regardless, so Monaco reveals the line once the model is up.
   */
  onCrossFile: (workspacePath: string, line: number) => void;
  /** A resolution that cannot be acted on, for the panel's notice bar. */
  onNotice: (message: string) => void;
  /** Workspace-relative path of a project-relative one. */
  toWorkspacePath: (project: string, path: string) => string;
  languages: readonly string[];
};

/**
 * Monaco's Uri for a workspace-relative path.
 *
 * `file:` rather than `inmemory:`, because Monaco derives a language from the
 * path when the model is created by Uri and a scheme it does not know about
 * gets no tokenizer. The path is workspace-relative on purpose — it is the one
 * form every part of this feature already speaks, so a Uri round-trips back to
 * a request without a second convention.
 */
export const uriForWorkspacePath = (workspacePath: string) =>
  monaco.Uri.from({ path: `/${workspacePath}`, scheme: "file" });

/** The workspace-relative path a Uri was built from. */
export const workspacePathForUri = (uri: Monaco.Uri) =>
  uri.path.replace(/^\//, "");

/**
 * The model for a path, created from disk if Monaco does not have one.
 *
 * Returning a `Location` for a Uri with no model makes Monaco's hover path
 * reject inside a promise it does not catch, so this is not an optimisation —
 * it is what stops a cmd-hover over an import from throwing.
 *
 * Models made here live in Monaco's own registry, keyed by Uri, so a second
 * cmd+click on the same import finds the one already built. If the operator
 * then *opens* that file, `CodeEditor` adopts this very model rather than
 * creating a second one for the same Uri — which `createModel` would throw on —
 * and disposes it with the editor. One built for a definition never opened
 * outlives the panel; they are small, and the alternative is disposing a model
 * the editor may be about to adopt.
 */
async function ensureModel(
  workspacePath: string,
  readFile: ReadFile,
): Promise<Monaco.editor.ITextModel | null> {
  const uri = uriForWorkspacePath(workspacePath);
  const existing = monaco.editor.getModel(uri);
  if (existing) return existing;

  const content = await readFile(workspacePath);
  if (content === null) return null;

  // Between the check above and here another cmd+click may have created it;
  // createModel throws on a duplicate Uri, so the registry is re-checked.
  return (
    monaco.editor.getModel(uri) ??
    monaco.editor.createModel(content, undefined, uri)
  );
}

/**
 * Register the provider, and the opener that keeps file switching in the
 * panel's hands.
 *
 * Returns a disposable that unregisters both. Registered per editor instance
 * rather than once at module scope, because the callbacks close over the
 * panel's current selection and its notice bar.
 */
export function registerDefinitionProvider(
  config: DefinitionProviderConfig,
): Monaco.IDisposable {
  /**
   * Answers by position.
   *
   * The gesture calls the provider on every cmd-hover, and a hover over one
   * token produces several calls as the pointer moves within it. Without this
   * a slow drag across a line is a request per pixel-row of travel.
   *
   * Keyed by file *and* position, and cleared when the panel says the file
   * changed on disk — a stale answer would send a click to a line that has
   * since moved, which is worse than a slow one.
   */
  const cache = new Map<string, DefinitionAnswer>();

  const provider: Monaco.languages.DefinitionProvider = {
    async provideDefinition(model, position) {
      const current = config.current();
      if (!current) return null;

      // Only the file the panel has open can be attributed to a project. A
      // model created by `ensureModel` for a definition target is a legitimate
      // thing to have on screen, but a cursor in it belongs to no project this
      // provider can address, so it resolves nothing rather than guessing.
      const openUri = uriForWorkspacePath(
        config.toWorkspacePath(current.project, current.path),
      );
      if (model.uri.toString() !== openUri.toString()) return null;

      const key = `${model.uri.toString()}:${position.lineNumber}:${position.column}`;
      let answer = cache.get(key);

      if (!answer) {
        const fetched = await config.resolve({
          character: position.column,
          line: position.lineNumber,
          path: current.path,
          project: current.project,
        });
        if (!fetched) return null;
        cache.set(key, fetched);
        answer = fetched;
      }

      const found = answer.definition;
      if (!found) return null;

      if (!found.path) {
        // Resolved to something real that has no workspace-relative name — a
        // dependency installed outside the workspace. Saying so beats an
        // underline that does nothing when clicked.
        config.onNotice(
          `${found.name} is declared outside this workspace, so it cannot be opened here.`,
        );
        return null;
      }

      const targetPath = found.path;
      const model2 = await ensureModel(targetPath, config.readFile);
      if (!model2) {
        config.onNotice(`Unable to read ${targetPath}.`);
        return null;
      }

      // Clamped: the file on disk can have changed since the checker's program
      // snapshot was built, and an out-of-range Location throws in Monaco.
      const line = Math.min(Math.max(1, found.line), model2.getLineCount());

      return [
        {
          range: new monaco.Range(line, 1, line, model2.getLineMaxColumn(line)),
          uri: model2.uri,
        },
      ];
    },
  };

  const disposables = config.languages.map((language) =>
    monaco.languages.registerDefinitionProvider(language, provider),
  );

  /**
   * A jump out of the open file.
   *
   * Monaco would otherwise do nothing for a Uri other than the attached
   * model's — the standalone editor has no concept of opening a second file.
   * Returning `true` claims the request, and the panel then changes its own
   * selection; the editor follows because the panel re-renders it with a new
   * path, not because Monaco swapped the model underneath it.
   */
  const opener = monaco.editor.registerEditorOpener({
    openCodeEditor(_source, resource, selectionOrPosition) {
      const workspacePath = workspacePathForUri(resource);
      const line =
        selectionOrPosition && "startLineNumber" in selectionOrPosition
          ? selectionOrPosition.startLineNumber
          : selectionOrPosition?.lineNumber;

      config.onCrossFile(workspacePath, line ?? 1);
      return true;
    },
  });

  return {
    dispose() {
      for (const disposable of disposables) disposable.dispose();
      opener.dispose();
      cache.clear();
    },
  };
}
