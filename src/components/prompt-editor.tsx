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
  PromptInputActionAddAttachments,
  PromptInputActionAddScreenshot,
  PromptInputActionMenu,
  PromptInputActionMenuContent,
  PromptInputActionMenuTrigger,
  PromptInputBody,
  PromptInputButton,
  PromptInputFooter,
  PromptInputProvider,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  usePromptInputAttachments,
} from "@/components/ai-elements/prompt-input";
import { useModels, type PiModel } from "@/hooks/use-models";
import {
  useUpdateUserSettings,
  useUserSettings,
} from "@/hooks/use-user-settings";

import { CheckIcon, GlobeIcon, WrenchIcon } from "lucide-react";
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
  goalEditor?: ReactNode;
}

export function PromptEditor({
  defaultTools,
  goalEditor,
  onSubmit,
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
  const matchingTools = defaultTools.filter((tool) =>
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

  const configurationError =
    modelsError ?? userSettingsError ?? updateUserSettingsError;

  return (
    <div className="flex w-full flex-col gap-2">
      {configurationError && (
        <p className="mb-2 text-sm text-destructive" role="alert">
          {configurationError.message}
        </p>
      )}
      <PromptInputProvider>
        <PromptInput
          globalDrop
          multiple
          onSubmit={handleSubmit}
          overflowVisible
        >
          <PromptInputAttachmentsDisplay />
          <PromptInputBody>
            {goalEditor}
            <PromptInputTextarea />
          </PromptInputBody>
          <PromptInputFooter>
            <PromptInputTools>
              <PromptInputActionMenu>
                <PromptInputActionMenuTrigger />
                <PromptInputActionMenuContent>
                  <PromptInputActionAddAttachments />
                  <PromptInputActionAddScreenshot />
                </PromptInputActionMenuContent>
              </PromptInputActionMenu>
              <PromptInputButton>
                <GlobeIcon size={16} />
                <span>Search</span>
              </PromptInputButton>
              <div className="relative" ref={toolPickerRef}>
                <PromptInputButton
                  aria-expanded={toolPickerOpen}
                  aria-haspopup="listbox"
                  onClick={() => setToolPickerOpen((open) => !open)}
                >
                  <WrenchIcon size={16} />
                  <span>{tools.length} tools</span>
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
                      {matchingTools.length > 0 ? (
                        matchingTools.map((tool) => {
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
                        })
                      ) : (
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
                    {[
                      ...new Set(models.map((candidate) => candidate.provider)),
                    ].map((provider) => (
                      <ModelSelectorGroup heading={provider} key={provider}>
                        {models
                          .filter(
                            (candidate) => candidate.provider === provider,
                          )
                          .map((m) => (
                            <ModelItem
                              key={`${m.provider}:${m.modelId}`}
                              m={m}
                              onSelect={handleModelSelect}
                              selectedModel={selectedModelKey}
                            />
                          ))}
                      </ModelSelectorGroup>
                    ))}
                  </ModelSelectorList>
                </ModelSelectorContent>
              </ModelSelector>
            </PromptInputTools>
            <PromptInputSubmit status={status} />
          </PromptInputFooter>
        </PromptInput>
      </PromptInputProvider>
    </div>
  );
}
