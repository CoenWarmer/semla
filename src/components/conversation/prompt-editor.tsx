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
  usePromptInputController,
} from "@/components/ai-elements/prompt-input";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  useJevGateSetting,
  useUpdateJevGateSetting,
} from "@/hooks/use-jev-gate-setting";
import { useMcpStatus } from "@/hooks/use-mcp-status";
import { useModels, type PiModel } from "@/hooks/use-models";
import {
  useReadRouterSetting,
  useUpdateReadRouterSetting,
} from "@/hooks/use-read-router-setting";
import { useSkills, type PiSkill } from "@/hooks/use-skills";
import { useTools } from "@/hooks/use-tools";
import { slashSkillCommand } from "@/lib/pi/skills/slash-skill-query";
import {
  useUpdateUserSettings,
  useUserSettings,
} from "@/hooks/use-user-settings";

import {
  BookOpenIcon,
  CheckIcon,
  FilterIcon,
  FoldVerticalIcon,
  RouteIcon,
  ServerIcon,
  WrenchIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";
import {
  memo,
  ReactNode,
  useCallback,
  useEffect,
  useMemo,
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

/**
 * Inserts `/skill:name ` for a chosen skill into the shared text input.
 *
 * Appended after existing text rather than replacing it, and with a leading
 * space when the box is non-empty: a skill picked from the toolbar button is
 * additive ("also use this skill"), so it never overwrites what is already
 * there. The slash-triggered inline picker replaces the input outright
 * instead, since there the user has typed a `/` command prefix to complete.
 */
function useInsertSkillMention() {
  const controller = usePromptInputController();

  return useCallback(
    (skillName: string) => {
      const current = controller.textInput.value;
      const mention = slashSkillCommand(skillName);
      const next =
        current.length === 0 || current.endsWith(" ")
          ? `${current}${mention}`
          : `${current} ${mention}`;
      controller.textInput.setInput(next);
    },
    [controller],
  );
}

/**
 * Matches the entire input when it is a single in-progress `/` token with no
 * space yet — the state where the user is typing a slash command and a
 * completion should show. Once a space appears the user has moved past the
 * command name (into its arguments, or plain text that happens to start with
 * `/`), and suggestions should disappear rather than keep matching a stale
 * prefix.
 */
const SLASH_TOKEN_PATTERN = /^\/(\S*)$/;

/**
 * Drives the inline `/`-triggered skill suggestion list: derives the filtered
 * matches from the textarea's own value (no separate query state, since the
 * query *is* whatever the user typed after `/`) and tracks which row is
 * highlighted for keyboard selection.
 */
function useSlashSkillSuggestions(skills: PiSkill[]) {
  const controller = usePromptInputController();
  const [selectedIndex, setSelectedIndex] = useState(0);

  const match = SLASH_TOKEN_PATTERN.exec(controller.textInput.value);
  const query = match?.[1] ?? null;
  const matches = useMemo(
    () =>
      query === null
        ? []
        : skills.filter((skill) =>
            skill.name.toLowerCase().startsWith(query.toLowerCase()),
          ),
    [skills, query],
  );
  const open = query !== null && matches.length > 0;

  // The set of matches changes on every keystroke; a highlight index left
  // over from a longer list would point past the end of a shorter one, or at
  // an unrelated row. Reset during render rather than in an effect — this is
  // the documented "adjusting state when a prop changes" pattern: comparing
  // against a ref of the last-seen query and calling setState synchronously
  // in that case is what avoids the extra render an effect-based reset would
  // cost, and the lint rule flags exactly that effect form.
  const previousQueryRef = useRef(query);
  if (previousQueryRef.current !== query) {
    previousQueryRef.current = query;
    if (selectedIndex !== 0) {
      setSelectedIndex(0);
    }
  }

  const pick = useCallback(
    (skillName: string) => {
      // Replaces the whole input outright, unlike the toolbar button's
      // `insertSkillMention` (which appends onto whatever text is already
      // there): the `/partial` being completed here IS the whole input, so
      // there is nothing to preserve alongside the result.
      //
      // This used to call `controller.textInput.clear()` followed by
      // `insertSkillMention(skillName)`, which read `controller.textInput
      // .value` to build the replacement — but `clear()` only queues a state
      // update; the very next line still read the pre-clear value from this
      // same render, so the mention was appended onto the stale `/partial`
      // instead of replacing it (`/foo /skill:foo`). Setting the input
      // directly avoids reading any stale value at all.
      controller.textInput.setInput(slashSkillCommand(skillName));
    },
    [controller],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (!open) {
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSelectedIndex((current) => (current + 1) % matches.length);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setSelectedIndex(
          (current) => (current - 1 + matches.length) % matches.length,
        );
      } else if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        const chosen = matches[selectedIndex];
        if (chosen) {
          pick(chosen.name);
        }
      } else if (event.key === "Escape") {
        event.preventDefault();
        // Nothing to close explicitly — moving past the slash token (a space,
        // or clearing it) is what hides the list, so a no-op edit would leave
        // it open. Blurring is the honest "dismiss" for a list with no
        // separate open/closed state of its own.
        (event.target as HTMLTextAreaElement).blur();
      }
    },
    [open, matches, selectedIndex, pick],
  );

  return { handleKeyDown, matches, open, pick, selectedIndex };
}

/**
 * The textarea plus the `/`-triggered completion list that floats above it
 * while the user is mid-way through typing a skill's name. Combined into one
 * component, rather than a separate list alongside a plain
 * `PromptInputTextarea`, because `useSlashSkillSuggestions` reads and writes
 * the shared controller `usePromptInputController()` exposes — it must run
 * inside `PromptInputProvider`, which is a descendant of `PromptEditor`'s own
 * render, not an ancestor of it.
 *
 * Complements `SkillPickerButton`: that one is a browse-and-search menu
 * opened deliberately, this one is a suggestion that appears and disappears
 * as a side effect of typing, so it carries no open/close state of its own
 * beyond what the textarea's current value implies.
 */
function PromptTextareaWithSkillSuggestions({ skills }: { skills: PiSkill[] }) {
  const { handleKeyDown, matches, open, pick, selectedIndex } =
    useSlashSkillSuggestions(skills);

  return (
    // A Fragment, not a wrapping div: `PromptInputTextarea` must stay a
    // direct child of `InputGroup`, which sizes itself via a `has-[>textarea]`
    // direct-child selector (see the comment at this component's call site).
    // `InputGroup` itself is already `position: relative`, so the popup below
    // positions against it as a plain sibling instead.
    <>
      {open && (
        <div
          className="absolute bottom-full left-0 z-50 mb-1 w-72 rounded-md border bg-popover p-1 shadow-lg"
          // Same listbox rationale as the tool/skill picker menus: a filtered
          // list of rows with keyboard-driven highlight state, not a value
          // a native `<select>`/`<datalist>` can represent.
          // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
          role="listbox"
        >
          {matches.map((skill, index) => (
            <button
              aria-selected={index === selectedIndex}
              className={cn(
                "flex w-full flex-col items-start gap-0.5 rounded-sm px-2 py-1.5 text-left",
                index === selectedIndex ? "bg-accent" : "hover:bg-accent",
              )}
              key={skill.name}
              // Mousedown, not click: a click fires after the textarea's
              // blur, and blur is what several browsers use to decide the
              // suggestion list should already be gone.
              onMouseDown={(event) => {
                event.preventDefault();
                pick(skill.name);
              }}
              // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
              role="option"
              type="button"
            >
              <span className="flex w-full items-center justify-between gap-2 text-sm">
                /skill:{skill.name}
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  {skill.source}
                </span>
              </span>
              <span className="line-clamp-1 text-xs text-muted-foreground">
                {skill.description}
              </span>
            </button>
          ))}
        </div>
      )}
      <PromptInputTextarea className="min-h-8" onKeyDown={handleKeyDown} />
    </>
  );
}

interface SkillPickerButtonProps {
  compactToolbar: boolean;
  matchingSkills: PiSkill[];
  open: boolean;
  pickerRef: React.RefObject<HTMLDivElement | null>;
  query: string;
  setOpen: (open: boolean | ((current: boolean) => boolean)) => void;
  setQuery: (query: string) => void;
  skillCount: number;
}

/**
 * Toolbar button + popup listing every skill this session can invoke, same
 * shape as the tools button beside it (search input, scrollable listbox).
 * Clicking a skill inserts `/skill:name` into the shared input rather than
 * running it immediately — a mention the user can still edit or add
 * arguments to before submitting, mirroring how the toolbar's tool picker
 * only toggles availability rather than acting.
 */
const SkillPickerButton = ({
  compactToolbar,
  matchingSkills,
  open,
  pickerRef,
  query,
  setOpen,
  setQuery,
  skillCount,
}: SkillPickerButtonProps) => {
  const insertSkillMention = useInsertSkillMention();

  const handlePick = useCallback(
    (skillName: string) => {
      insertSkillMention(skillName);
      setOpen(false);
      setQuery("");
    },
    [insertSkillMention, setOpen, setQuery],
  );

  return (
    <div className="relative" ref={pickerRef}>
      <PromptInputButton
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label={compactToolbar ? `${skillCount} skills` : undefined}
        onClick={() => setOpen((current) => !current)}
        tooltip={compactToolbar ? `${skillCount} skills` : undefined}
      >
        <BookOpenIcon size={16} />
        {!compactToolbar && <span className="text-xs">{skillCount} skills</span>}
      </PromptInputButton>
      {open && (
        <div className="absolute bottom-full left-0 z-50 mb-2 w-72 rounded-md border bg-popover p-1 shadow-lg">
          <input
            aria-label="Search skills"
            className="mb-1 h-8 w-full rounded-sm bg-transparent px-2 text-sm outline-none placeholder:text-muted-foreground"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search skills..."
            value={query}
          />
          {/* Same listbox rationale as the tool picker: a filtered list of
              rows with a name and a description, not a single-value select. */}
          {/* oxlint-disable-next-line jsx-a11y/prefer-tag-over-role */}
          <div className="max-h-64 overflow-y-auto" role="listbox">
            {matchingSkills.map((skill) => (
              <button
                className="flex w-full flex-col items-start gap-0.5 rounded-sm px-2 py-1.5 text-left hover:bg-accent"
                key={skill.name}
                onClick={() => handlePick(skill.name)}
                type="button"
              >
                <span className="flex w-full items-center justify-between gap-2 text-sm">
                  {skill.name}
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    {skill.source}
                  </span>
                </span>
                <span className="line-clamp-2 text-xs text-muted-foreground">
                  {skill.description}
                </span>
              </button>
            ))}
            {matchingSkills.length === 0 && (
              <p className="px-2 py-3 text-center text-sm text-muted-foreground">
                No skills found.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
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
   * Hide the toolbar buttons' text labels and fall back to icon-only
   * buttons with a tooltip, because the column this editor is rendered in
   * has gotten too narrow for the full row — driven by a `ResizeObserver`
   * on the conversation column, not a viewport media query, since that
   * column can be one side of a resizable split and narrow independently
   * of the window.
   */
  compactToolbar?: boolean;
  /** Estimated cost of one additional turn given the current context size, in USD. */
  costPerTurn?: number | null;
  /** Trigger manual context compaction. Absent when unavailable (e.g. no live session). */
  onCompactClick?: () => void;
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
  compactToolbar = false,
  defaultTools,
  goalEditor,
  costPerTurn,
  onCompactClick,
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
  const { data: mcpStatus } = useMcpStatus();
  const readRouter = useReadRouterSetting();
  const updateReadRouter = useUpdateReadRouterSetting();
  const jevGate = useJevGateSetting();
  const updateJevGate = useUpdateJevGateSetting();

  const { error: updateUserSettingsError, mutate: updateUserSettings } =
    useUpdateUserSettings();

  const [model, setModel] = useState("");
  const [modelSelectorOpen, setModelSelectorOpen] = useState(false);
  const [toolPickerOpen, setToolPickerOpen] = useState(false);
  const [toolQuery, setToolQuery] = useState("");
  const [skillPickerOpen, setSkillPickerOpen] = useState(false);
  const [skillQuery, setSkillQuery] = useState("");
  const [tools, setTools] = useState(defaultTools);
  const [status, setStatus] = useState<
    "submitted" | "streaming" | "ready" | "error"
  >("ready");
  const readRouterEnabled = readRouter.data?.enabled ?? true;
  const jevGateEnabled = jevGate.data?.enabled ?? false;

  const toolPickerRef = useRef<HTMLDivElement>(null);
  const skillPickerRef = useRef<HTMLDivElement>(null);
  const { data: skills = [] } = useSkills(sessionId);

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
  // Only shown once the mcp extension tool is actually present — mirrors the
  // health card's own "an extension that never loaded should not be implied
  // to exist" rule, rather than assuming the manifest entry is always there.
  const mcpEnabled = extensionTools.includes("mcp");
  const mcpServerCount = mcpStatus?.enabledServers.length ?? 0;
  const matchingSkills = useMemo(
    () =>
      skills.filter(
        (skill) =>
          skill.name.toLowerCase().includes(skillQuery.toLowerCase()) ||
          skill.description.toLowerCase().includes(skillQuery.toLowerCase()),
      ),
    [skills, skillQuery],
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

  useEffect(() => {
    if (!skillPickerOpen) {
      return;
    }

    const closeWhenClickingOutside = (event: PointerEvent) => {
      if (
        skillPickerRef.current &&
        event.target instanceof Node &&
        !skillPickerRef.current.contains(event.target)
      ) {
        setSkillPickerOpen(false);
      }
    };

    document.addEventListener("pointerdown", closeWhenClickingOutside);
    return () =>
      document.removeEventListener("pointerdown", closeWhenClickingOutside);
  }, [skillPickerOpen]);

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
    <div className="group flex w-full flex-col gap-1">
      {configurationError && (
        <p className="mb-2 text-sm text-destructive" role="alert">
          {configurationError.message}
        </p>
      )}

      {/*
        One PromptInputProvider wraps the toolbar and the input box together,
        rather than only the box as before: the skills picker button lives in
        the toolbar but needs to append to the same text the textarea below
        edits, and appending requires the shared controller both sides read
        from.
      */}
      <PromptInputProvider>
      <PromptInputTools>
        {/*
          Bounded and truncating rather than `flex-1`: a long goal would
          otherwise push the attachment, search and tool buttons across
          the row, and their position should not depend on how much
          someone typed.
        */}
        {goalEditor && (
          <div className="flex grow min-w-0 gap-4">
            {goalEditor}
            <div className="flex self-end">
              {costPerTurn != null && (
                <span
                  className={cn(
                    "shrink-0 text-[10px] tabular-nums",
                    costPerTurn < 0.01
                      ? "text-muted-foreground/60"
                      : costPerTurn < 0.05
                        ? "text-muted-foreground"
                        : costPerTurn < 0.15
                          ? "text-amber-500"
                          : "text-red-500",
                  )}
                  title="Estimated cache-read cost per additional turn at the current context size"
                >
                  ≈
                  {costPerTurn < 0.01
                    ? "<$0.01"
                    : `$${costPerTurn.toFixed(costPerTurn >= 1 ? 2 : 3)}`}{" "}
                  / turn
                </span>
              )}
            </div>
          </div>
        )}
        <div
          className={cn(
            "flex items-center transition-opacity group-focus-within:opacity-80 group-hover:opacity-80",
            // Held visible while either menu is open: they hang off these
            // buttons, so fading the buttons out from under an open menu
            // would take the menu with them.
            toolPickerOpen || modelSelectorOpen ? "opacity-80" : "opacity-0",
          )}
        >
          {onCompactClick && !isRunning && (
            <PromptInputButton
              aria-label={
                compactToolbar
                  ? "Summarise conversation history to free up context window space"
                  : undefined
              }
              onClick={onCompactClick}
              title={compactToolbar ? undefined : "Summarise conversation history to free up context window space"}
              tooltip={
                compactToolbar
                  ? "Summarise conversation history to free up context window space"
                  : undefined
              }
            >
              <FoldVerticalIcon size={12} />
              {!compactToolbar && <span className="text-xs">Compact</span>}
            </PromptInputButton>
          )}
          <PromptInputButton
            aria-label={
              compactToolbar
                ? readRouterEnabled
                  ? "Disable read-router tool-result compression"
                  : "Enable read-router tool-result compression"
                : undefined
            }
            aria-pressed={readRouterEnabled}
            className={cn(
              readRouterEnabled && "bg-muted text-foreground",
            )}
            disabled={
              readRouter.isPending ||
              readRouter.isError ||
              updateReadRouter.isPending
            }
            onClick={() => updateReadRouter.mutate(!readRouterEnabled)}
            title={
              compactToolbar
                ? undefined
                : readRouter.isError
                  ? readRouter.error.message
                  : readRouterEnabled
                    ? "Disable read-router tool-result compression"
                    : "Enable read-router tool-result compression"
            }
            tooltip={
              compactToolbar
                ? readRouter.isError
                  ? readRouter.error.message
                  : readRouterEnabled
                    ? "Disable read-router tool-result compression"
                    : "Enable read-router tool-result compression"
                : undefined
            }
          >
            <RouteIcon size={16} />
            {!compactToolbar && (
              <span className="text-xs">
                Read router {readRouterEnabled ? "on" : "off"}
              </span>
            )}
          </PromptInputButton>
          <PromptInputButton
            aria-label={
              compactToolbar
                ? jevGateEnabled
                  ? "Disable Jev gate tool/skill filtering"
                  : "Enable Jev gate tool/skill filtering"
                : undefined
            }
            aria-pressed={jevGateEnabled}
            className={cn(jevGateEnabled && "bg-muted text-foreground")}
            disabled={
              jevGate.isPending ||
              jevGate.isError ||
              updateJevGate.isPending
            }
            onClick={() => updateJevGate.mutate(!jevGateEnabled)}
            title={
              compactToolbar
                ? undefined
                : jevGate.isError
                  ? jevGate.error.message
                  : jevGateEnabled
                    ? "Disable Jev gate tool/skill filtering"
                    : "Enable Jev gate tool/skill filtering"
            }
            tooltip={
              compactToolbar
                ? jevGate.isError
                  ? jevGate.error.message
                  : jevGateEnabled
                    ? "Disable Jev gate tool/skill filtering"
                    : "Enable Jev gate tool/skill filtering"
                : undefined
            }
          >
            <FilterIcon size={16} />
            {!compactToolbar && (
              <span className="text-xs">
                Jev gate {jevGateEnabled ? "on" : "off"}
              </span>
            )}
          </PromptInputButton>
          <div className="relative" ref={toolPickerRef}>
            <PromptInputButton
              aria-expanded={toolPickerOpen}
              aria-haspopup="listbox"
              aria-label={
                compactToolbar
                  ? `${tools.length + extensionTools.length} tools`
                  : undefined
              }
              onClick={() => setToolPickerOpen((open) => !open)}
              tooltip={
                compactToolbar
                  ? `${tools.length + extensionTools.length} tools`
                  : undefined
              }
            >
              <WrenchIcon size={16} />
              {!compactToolbar && (
                <span className="text-xs">
                  {tools.length + extensionTools.length} tools
                </span>
              )}
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
                {/*
                  A real `<select>`/`<datalist>` cannot render this: each row
                  needs a checkmark slot beside its label reflecting
                  independent toggle state, not a single chosen value, and
                  the list above it is filtered by a search field rather than
                  the browser's own type-ahead. `listbox`/`option` are the
                  ARIA pattern built for exactly this custom widget.
                */}
                {/* oxlint-disable-next-line jsx-a11y/prefer-tag-over-role */}
                <div className="max-h-56 overflow-y-auto" role="listbox">
                  {matchingToggleableTools.map((tool) => {
                    const selected = tools.includes(tool);

                    return (
                      <button
                        aria-selected={selected}
                        className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent"
                        key={tool}
                        onClick={() => toggleTool(tool)}
                        // Real `<option>` cannot hold this markup (a
                        // checkmark plus label) or the click handling below
                        // — see the `listbox` comment above it.
                        // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
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
          <SkillPickerButton
            compactToolbar={compactToolbar}
            matchingSkills={matchingSkills}
            open={skillPickerOpen}
            pickerRef={skillPickerRef}
            query={skillQuery}
            setOpen={setSkillPickerOpen}
            setQuery={setSkillQuery}
            skillCount={skills.length}
          />
          {mcpEnabled && (
            <Tooltip>
              {/*
              `render` rather than nesting PromptInputButton as children:
              TooltipTrigger renders its own <button> by default, and
              PromptInputButton renders one too — nested as children that is
              a <button> inside a <button>, invalid HTML that React hydrates
              inconsistently. `render` swaps TooltipTrigger's own host element
              for this one instead of wrapping it.
            */}
              <TooltipTrigger
                render={
                  <PromptInputButton
                    aria-label={
                      compactToolbar
                        ? `${mcpServerCount} MCP server${mcpServerCount === 1 ? "" : "s"}`
                        : undefined
                    }
                  >
                    <ServerIcon size={16} />
                    {!compactToolbar && (
                      <span className="text-xs">
                        {mcpServerCount} MCP server
                        {mcpServerCount === 1 ? "" : "s"}
                      </span>
                    )}
                  </PromptInputButton>
                }
              />
              <TooltipContent side="top">
                {mcpStatus?.error ? (
                  <span>mcp.json does not parse: {mcpStatus.error}</span>
                ) : mcpStatus?.hint ? (
                  <span>{mcpStatus.hint}</span>
                ) : mcpServerCount > 0 ? (
                  <span>{mcpStatus?.enabledServers.join(", ")}</span>
                ) : (
                  <span>
                    No MCP servers configured. Edit{" "}
                    {mcpStatus?.configPath ?? "mcp.json"}.
                  </span>
                )}
              </TooltipContent>
            </Tooltip>
          )}
          <ModelSelector
            onOpenChange={setModelSelectorOpen}
            open={modelSelectorOpen}
          >
            <ModelSelectorTrigger
              render={
                <PromptInputButton
                  aria-label={
                    compactToolbar
                      ? selectedModelData?.name ?? "Select model"
                      : undefined
                  }
                  tooltip={
                    compactToolbar
                      ? selectedModelData?.name ?? "Select model"
                      : undefined
                  }
                />
              }
            >
              {selectedModelData && (
                <ModelSelectorLogo provider={selectedModelData.provider} />
              )}
              {!compactToolbar && (
                <ModelSelectorName className="text-xs">
                  {selectedModelData?.name ?? "Select model"}
                </ModelSelectorName>
              )}
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
                ))}
              </ModelSelectorList>
            </ModelSelectorContent>
          </ModelSelector>
        </div>
      </PromptInputTools>

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
          <PromptTextareaWithSkillSuggestions skills={skills} />
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
