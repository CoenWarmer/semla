"use client";

import {
  Attachment,
  AttachmentPreview,
  AttachmentRemove,
  Attachments,
} from "@/components/ai-elements/attachments";
import {
  ModelSelector,
  ModelSelectorContent,
  ModelSelectorEmpty,
  ModelSelectorGroup,
  ModelSelectorInput,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorLogo,
  ModelSelectorLogoGroup,
  ModelSelectorName,
  ModelSelectorTrigger,
} from "@/components/ai-elements/model-selector";
import type { PromptInputMessage } from "@/components/ai-elements/prompt-input";
import {
  PromptInput,
  PromptInputButton,
  PromptInputProvider,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  usePromptInputAttachments,
} from "@/components/ai-elements/prompt-input";
import { useModels, type PiModel } from "@/hooks/use-models";
import { useTools } from "@/hooks/use-tools";
import {
  useUpdateUserSettings,
  useUserSettings,
} from "@/hooks/use-user-settings";

import { CheckIcon, WrenchIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  memo,
  ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

export type PromptEditorModel = Pick<PiModel, "modelId" | "provider">;

type ModelOption = PiModel;

interface AttachmentItemProps {
  attachment: {
    id: string;
    type: "file";
    filename?: string;
    mediaType?: string;
    url: string;
  };
  onRemove: (id: string) => void;
}

const AttachmentItem = memo(({ attachment, onRemove }: AttachmentItemProps) => {
  const handleRemove = useCallback(
    () => onRemove(attachment.id),
    [onRemove, attachment.id],
  );
  return (
    <Attachment
      data={{
        ...attachment,
        mediaType: attachment.mediaType ?? "application/octet-stream",
      }}
      key={attachment.id}
      onRemove={handleRemove}
    >
      <AttachmentPreview />
      <AttachmentRemove />
    </Attachment>
  );
});

AttachmentItem.displayName = "AttachmentItem";

interface ModelItemProps {
  m: ModelOption;
  selectedModel: string;
  onSelect: (id: string) => void;
}

const ModelItem = memo(({ m, selectedModel, onSelect }: ModelItemProps) => {
  const modelKey = `${m.provider}:${m.modelId}`;
  const handleSelect = useCallback(
    () => onSelect(modelKey),
    [modelKey, onSelect],
  );

  return (
    <ModelSelectorItem onSelect={handleSelect} value={modelKey}>
      <ModelSelectorLogo provider={m.provider} />
      <ModelSelectorName>{m.name}</ModelSelectorName>
      <ModelSelectorLogoGroup>
        <ModelSelectorLogo provider={m.provider} />
      </ModelSelectorLogoGroup>
      {selectedModel === modelKey ? (
        <CheckIcon className="ml-auto size-4" />
      ) : (
        <div className="ml-auto size-4" />
      )}
    </ModelSelectorItem>
  );
});

ModelItem.displayName = "ModelItem";

const PromptInputAttachmentsDisplay = () => {
  const attachments = usePromptInputAttachments();

  const handleRemove = useCallback(
    (id: string) => attachments.remove(id),
    [attachments],
  );

  if (attachments.files.length === 0) {
    return null;
  }

  return (
    <Attachments variant="inline">
      {attachments.files.map((attachment) => (
        <AttachmentItem
          attachment={attachment}
          key={attachment.id}
          onRemove={handleRemove}
        />
      ))}
    </Attachments>
  );
};

interface PromptEditorProps {
  onSubmit?: (
    message: PromptInputMessage,
    model: PromptEditorModel,
    tools: string[],
  ) => Promise<void> | void;
  defaultTools: string[];
  /**
   * The session's goal control, rendered in the footer's tool row.
   *
   * A slot rather than a `goal` prop and a save callback, so this editor knows
   * nothing about goals or the route that stores them — it renders what it is
   * handed, beside its own buttons.
   */
  goalEditor?: ReactNode;
  /**
   * The session has a turn in flight. Driven by the parent rather than the
   * editor's own submit state, which knows nothing about a turn still running
   * after a reload or one continuing in the background.
   */
  isRunning?: boolean;
  /** Interrupt that turn. Without it the button stays a submit button. */
  onStop?: () => void;
  /**
   * Which session this editor belongs to, so the tool list is the one that
   * session will actually run with. Absent on /sessions/new, where no session
   * exists yet and the full set is the right answer.
   */
  sessionId?: string;
  /**
   * Reports the model and tools a submit would use right now.
   *
   * Editing a prompt runs a turn from somewhere else in the session, and it
   * should run with the same selection the prompt bar is showing. The
   * alternative was resolving the model a second time from user settings, which
   * is this component's own fallback logic duplicated and free to drift.
   */
  onSelectionChange?: (
    selection: { model: PromptEditorModel; tools: string[] } | null,
  ) => void;
}

export function PromptEditor({
  defaultTools,
  goalEditor,
  isRunning,
  onSelectionChange,
  onStop,
  onSubmit,
  sessionId,
}: PromptEditorProps) {
  const {
    data: models = [],
    error: modelsError,
    isSuccess: modelsLoaded,
  } = useModels();
  const {
    data: userSettings,
    error: userSettingsError,
    isSuccess: userSettingsLoaded,
  } = useUserSettings();
  const { data: piTools } = useTools(sessionId);

  const { error: updateUserSettingsError, mutate: updateUserSettings } =
    useUpdateUserSettings();

  const [model, setModel] = useState("");
  const [modelSelectorOpen, setModelSelectorOpen] = useState(false);
  const [toolPickerOpen, setToolPickerOpen] = useState(false);
  const [toolQuery, setToolQuery] = useState("");
  const [tools, setTools] = useState(defaultTools);
  const [status, setStatus] = useState<
    "submitted" | "streaming" | "ready" | "error"
  >("ready");

  const toolPickerRef = useRef<HTMLDivElement>(null);

  const defaultModelKey =
    userSettings?.default_model_id && userSettings.default_model_provider
      ? `${userSettings.default_model_provider}:${userSettings.default_model_id}`
      : "";
  const modelIsAvailable = models.some(
    (candidate) => `${candidate.provider}:${candidate.modelId}` === model,
  );
  const defaultModelIsAvailable = models.some(
    (candidate) =>
      `${candidate.provider}:${candidate.modelId}` === defaultModelKey,
  );
  const selectedModelKey = modelIsAvailable
    ? model
    : modelsLoaded && userSettingsLoaded
      ? defaultModelIsAvailable
        ? defaultModelKey
        : models[0]
          ? `${models[0].provider}:${models[0].modelId}`
          : ""
      : "";
  const selectedModelData = models.find(
    (candidate) =>
      `${candidate.provider}:${candidate.modelId}` === selectedModelKey,
  );
  const extensionTools = piTools?.extensionTools ?? [];
  const matchingToggleableTools = defaultTools.filter((tool) =>
    tool.toLowerCase().includes(toolQuery.toLowerCase()),
  );
  const matchingExtensionTools = extensionTools.filter((tool) =>
    tool.toLowerCase().includes(toolQuery.toLowerCase()),
  );

  const toggleTool = useCallback((tool: string) => {
    setTools((current) =>
      current.includes(tool)
        ? current.filter((currentTool) => currentTool !== tool)
        : [...current, tool],
    );
  }, []);

  useEffect(() => {
    if (!toolPickerOpen) {
      return;
    }

    const closeWhenClickingOutside = (event: PointerEvent) => {
      if (
        toolPickerRef.current &&
        event.target instanceof Node &&
        !toolPickerRef.current.contains(event.target)
      ) {
        setToolPickerOpen(false);
      }
    };

    document.addEventListener("pointerdown", closeWhenClickingOutside);
    return () =>
      document.removeEventListener("pointerdown", closeWhenClickingOutside);
  }, [toolPickerOpen]);

  const handleModelSelect = useCallback(
    (modelKey: string) => {
      const selectedModel = models.find(
        (candidate) =>
          `${candidate.provider}:${candidate.modelId}` === modelKey,
      );

      setModel(modelKey);
      setModelSelectorOpen(false);

      if (selectedModel) {
        updateUserSettings({
          defaultModelId: selectedModel.modelId,
          defaultModelProvider: selectedModel.provider,
        });
      }
    },
    [models, updateUserSettings],
  );

  const handleSubmit = useCallback(
    async (message: PromptInputMessage) => {
      const hasText = Boolean(message.text);
      const hasAttachments = Boolean(message.files?.length);

      if (!(hasText || hasAttachments)) {
        return;
      }

      setStatus("submitted");

      try {
        if (!selectedModelData) {
          throw new Error("Select a Pi model before submitting a prompt.");
        }

        await onSubmit?.(message, selectedModelData, tools);
        setStatus("ready");
      } catch (error) {
        console.error("Failed to submit prompt:", error);
        setStatus("error");
      }
    },
    [onSubmit, selectedModelData, tools],
  );

  // Reporting outward, not setting state here — the documented use for an
  // effect. Runs whenever the resolved model or the tool selection changes.
  useEffect(() => {
    onSelectionChange?.(
      selectedModelData ? { model: selectedModelData, tools } : null,
    );
  }, [onSelectionChange, selectedModelData, tools]);

  const configurationError =
    modelsError ?? userSettingsError ?? updateUserSettingsError;

  return (
    // `group` so the controls above the box can react to focus *inside* it:
    // they are siblings of the form, and no selector reaches sideways.
    // `group-focus-within` rather than `group-has-[textarea:focus]`, which
    // Tailwind accepted and then emitted no rule for — the class was in the
    // markup and nothing in the stylesheet.
    <div className="group flex w-full flex-col gap-2">
      {configurationError && (
        <p className="mb-2 text-sm text-destructive" role="alert">
          {configurationError.message}
        </p>
      )}

      <PromptInputTools>
        {/*
          Bounded and truncating rather than `flex-1`: a long goal would
          otherwise push the attachment, search and tool buttons across
          the row, and their position should not depend on how much
          someone typed.
        */}
        {goalEditor && <div className="flex grow min-w-0">{goalEditor}</div>}
        <div
          className={cn(
            "flex items-center gap-1 transition-opacity group-focus-within:opacity-80 group-hover:opacity-80",
            // Held visible while either menu is open: they hang off these
            // buttons, so fading the buttons out from under an open menu
            // would take the menu with them.
            toolPickerOpen || modelSelectorOpen ? "opacity-80" : "opacity-0",
          )}
        >
          <div className="relative" ref={toolPickerRef}>
          <PromptInputButton
            aria-expanded={toolPickerOpen}
            aria-haspopup="listbox"
            onClick={() => setToolPickerOpen((open) => !open)}
          >
            <WrenchIcon size={16} />
            <span>{tools.length + extensionTools.length} tools</span>
          </PromptInputButton>
          {toolPickerOpen && (
            <div className="absolute bottom-full left-0 z-50 mb-2 w-56 rounded-md border bg-popover p-1 shadow-lg">
              <input
                aria-label="Search tools"
                className="mb-1 h-8 w-full rounded-sm bg-transparent px-2 text-sm outline-none placeholder:text-muted-foreground"
                onChange={(event) => setToolQuery(event.target.value)}
                placeholder="Search tools..."
                value={toolQuery}
              />
              <div className="max-h-56 overflow-y-auto" role="listbox">
                {matchingToggleableTools.map((tool) => {
                  const selected = tools.includes(tool);

                  return (
                    <button
                      aria-selected={selected}
                      className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent"
                      key={tool}
                      onClick={() => toggleTool(tool)}
                      role="option"
                      type="button"
                    >
                      <span className="flex size-4 items-center justify-center">
                        {selected && <CheckIcon className="size-4" />}
                      </span>
                      {tool}
                    </button>
                  );
                })}
                {matchingExtensionTools.length > 0 && (
                  <>
                    <p className="mt-1 px-2 py-1 text-xs font-medium text-muted-foreground">
                      Extensions (always active)
                    </p>
                    {matchingExtensionTools.map((tool) => (
                      <div
                        className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm opacity-60"
                        key={tool}
                      >
                        <span className="flex size-4 items-center justify-center">
                          <CheckIcon className="size-4" />
                        </span>
                        {tool}
                      </div>
                    ))}
                  </>
                )}
                {matchingToggleableTools.length === 0 &&
                  matchingExtensionTools.length === 0 && (
                    <p className="px-2 py-3 text-center text-sm text-muted-foreground">
                      No tools found.
                    </p>
                  )}
              </div>
            </div>
          )}
        </div>
        <ModelSelector
          onOpenChange={setModelSelectorOpen}
          open={modelSelectorOpen}
        >
          <ModelSelectorTrigger render={<PromptInputButton />}>
            {selectedModelData && (
              <ModelSelectorLogo provider={selectedModelData.provider} />
            )}
            <ModelSelectorName>
              {selectedModelData?.name ?? "Select model"}
            </ModelSelectorName>
          </ModelSelectorTrigger>
          <ModelSelectorContent>
            <ModelSelectorInput placeholder="Search models..." />
            <ModelSelectorList>
              <ModelSelectorEmpty>No models found.</ModelSelectorEmpty>
              {[...new Set(models.map((candidate) => candidate.provider))].map(
                (provider) => (
                  <ModelSelectorGroup heading={provider} key={provider}>
                    {models
                      .filter((candidate) => candidate.provider === provider)
                      .map((m) => (
                        <ModelItem
                          key={`${m.provider}:${m.modelId}`}
                          m={m}
                          onSelect={handleModelSelect}
                          selectedModel={selectedModelKey}
                        />
                      ))}
                  </ModelSelectorGroup>
                ),
              )}
            </ModelSelectorList>
            </ModelSelectorContent>
          </ModelSelector>
        </div>
      </PromptInputTools>

      <PromptInputProvider>
        <PromptInput
          globalDrop
          multiple
          onSubmit={handleSubmit}
          overflowVisible
        >
          <PromptInputAttachmentsDisplay />
          {/*
            A direct child of the InputGroup, and it has to be. That group is
            `h-9` and only becomes `h-auto` through `has-[>textarea]` — a
            direct-child selector — or through a `data-align=block-end` addon,
            which is what `PromptInputFooter` was. With the textarea one div
            further down, the box stayed two lines tall while
            `field-sizing-content` grew the field, and `items-center` spilled
            the text out of both ends.
          */}
          {/*
            Shorter than the component's own `min-h-16`, passed here rather
            than edited into `ai-elements/`: that directory is vendored, so a
            re-vendor would revert it with nothing in the diff to notice. The
            component merges `className`, and tailwind-merge lets the later
            `min-h` win.
          */}
          <PromptInputTextarea className="min-h-8" />
          <div className="flex items-center p-3">
            <PromptInputSubmit
              onStop={onStop}
              size="icon-xs"
              status={isRunning ? "streaming" : status}
            />
          </div>
        </PromptInput>
      </PromptInputProvider>
    </div>
  );
}
