import { useRef, type FormEvent, type Ref } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, ImagePlus, LoaderCircle, Send } from "lucide-react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu";
import { AIImageAttachments } from "../../workspace/ai-image-attachments";
import {
  CONVERSATION_IMAGE_TYPES,
  MAX_CONVERSATION_IMAGES,
  type ConversationImage,
} from "../../workspace/ai-conversation-message";

interface ModraComposerProps {
  queueing?: boolean;
  queueSaving?: boolean;
  taskMode: "plan" | "build";
  onTaskMode: (mode: "plan" | "build") => void;
  contextActions?: import("react").ReactNode;
  referenceChips?: import("react").ReactNode;
  inputRef?: Ref<HTMLInputElement>;
  prompt: string;
  approvalMode: "request" | "auto";
  images: readonly ConversationImage[];
  readingImages: boolean;
  imageError: "imageCountError" | "imageTypeError" | "imageSizeError" | "imageReadError" | null;
  isBusy: boolean;
  submitPrompt: (event: FormEvent<HTMLFormElement>) => void;
  onPrompt: (text: string) => void;
  onApprovalMode: (mode: "request" | "auto") => void;
  onAddImages: (files: File[]) => void;
  onRemoveImage: (id: string) => void;
}
export function ModraComposer({
  queueing,
  queueSaving,
  taskMode,
  onTaskMode,
  contextActions,
  referenceChips,
  inputRef,
  prompt,
  approvalMode,
  images,
  readingImages,
  imageError,
  isBusy,
  submitPrompt,
  onPrompt,
  onApprovalMode,
  onAddImages,
  onRemoveImage,
}: ModraComposerProps) {
  const { t } = useTranslation("ai");
  const imageInputRef = useRef<HTMLInputElement>(null);
  return (
    <form
      className="ai-prompt-form flex shrink-0 flex-col gap-2 rounded-xl border border-border bg-sheet p-2"
      onSubmit={submitPrompt}
    >
      {referenceChips}
      {images.length > 0 && (
        <AIImageAttachments
          images={images}
          onRemove={
            isBusy || readingImages
              ? undefined
              : (id) => {
                  onRemoveImage(id);
                }
          }
        />
      )}
      {imageError && (
        <p className="m-0 text-[13px] text-destructive" role="alert">
          {t(imageError)}
        </p>
      )}
      <div className="flex w-full items-center gap-1.5">
        <label className="sr-only" htmlFor="ai-prompt">
          {t("message")}
        </label>
        <Input
          ref={inputRef}
          id="ai-prompt"
          className="h-8 rounded-lg border-transparent bg-soft/50 text-[13px] shadow-none"
          value={prompt}
          onChange={(event) => onPrompt(event.currentTarget.value)}
          onPaste={(event) => {
            const files = Array.from(event.clipboardData.items)
              .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
              .flatMap((item) => item.getAsFile() ?? []);
            if (!files.length) return;
            event.preventDefault();
            if (!isBusy && !readingImages) onAddImages(files);
          }}
          placeholder={t("placeholder")}
          autoComplete="off"
          disabled={isBusy}
        />
        <Button
          className="size-8 rounded-lg"
          type="submit"
          size="icon"
          aria-label={t(queueing ? "queuePrompt" : "send")}
          title={t(queueing ? "queuePrompt" : "send")}
          disabled={(!prompt.trim() && images.length === 0) || isBusy || readingImages || queueSaving}
        >
          <Send />
        </Button>
      </div>
      <div className="modra-composer-toolbar flex min-w-0 items-center justify-between gap-0.5">
        <div className="modra-mode-controls flex min-w-0 items-center">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button type="button" variant="ghost" size="sm" className="h-8 px-1 text-xs" />}
              aria-label={t("taskMode")}
              disabled={isBusy}
            >
              {t(taskMode === "plan" ? "planMode" : "buildMode")}
              <ChevronDown className="size-3.5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" className="min-w-0 w-max" aria-label={t("taskMode")}>
              <DropdownMenuRadioGroup
                value={taskMode}
                onValueChange={(value) => {
                  if (value === "plan" || value === "build") onTaskMode(value);
                }}
              >
                <DropdownMenuRadioItem value="plan">{t("planMode")}</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="build">{t("buildMode")}</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button type="button" variant="ghost" size="sm" className="h-8 px-1 text-xs" />}
              aria-label={t("approvalMode")}
              disabled={isBusy}
            >
              {t(approvalMode === "request" ? "requestApproval" : "autoApproval")}
              <ChevronDown className="size-3.5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" className="min-w-0 w-max" aria-label={t("approvalMode")}>
              <DropdownMenuRadioGroup
                value={approvalMode}
                onValueChange={(value) => {
                  if (value === "request" || value === "auto") onApprovalMode(value);
                }}
              >
                <DropdownMenuRadioItem value="request">{t("requestApproval")}</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="auto">{t("autoApproval")}</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <div className="modra-context-controls flex shrink-0 items-center [&_button]:size-7">
          <div className="flex items-center">
            {contextActions}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={t("addImages")}
              title={t("imageRequirements")}
              disabled={isBusy || readingImages || images.length >= MAX_CONVERSATION_IMAGES}
              onClick={() => imageInputRef.current?.click()}
            >
              {readingImages ? <LoaderCircle className="animate-spin" /> : <ImagePlus />}
            </Button>
          </div>
        </div>
      </div>
      <input
        ref={imageInputRef}
        type="file"
        data-testid="ai-image-input"
        accept={CONVERSATION_IMAGE_TYPES.join(",")}
        multiple
        hidden
        aria-label={t("addImages")}
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = "";
          onAddImages(files);
        }}
      />
    </form>
  );
}