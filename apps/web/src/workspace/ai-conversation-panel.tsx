import { useTranslation } from "react-i18next";
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { Bot, Check, ChevronDown, ImagePlus, LoaderCircle, Send, Settings2, X } from "lucide-react";
import { streamOpenAICompatibleChat } from "@open-3d/ai";
import { createAIModelingTools } from "@open-3d/ai";
import type { AIConnectionRetry, OpenAICompatibleChatMessage } from "@open-3d/ai";
import { loadAIProviderSettings } from "@open-3d/ai/settings";
import type { AIProviderSettings } from "@open-3d/ai/settings";
import { commandLabel } from "./localization";
import type { CommandRequest, ModelingDocument } from "@open-3d/model-core";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import {
  CONVERSATION_IMAGE_TYPES,
  MAX_CONVERSATION_IMAGES,
  conversationHistory,
  modelingContinuation,
  readConversationImage,
  validateConversationImages,
  type ConversationImage,
  type ConversationMessage,
  type ConversationToolCall,
} from "./ai-conversation-message";
import { AIImageAttachments } from "./ai-image-attachments";
import { AIToolCalls } from "./ai-tool-calls";

interface AIConversationPanelProps {
  active: boolean;
  document: ModelingDocument;
  settingsRevision: number;
  onOpenSettings: () => void;
  onPreviewDocument: (document: ModelingDocument | null) => void;
  onAcceptProposal: (commands: readonly CommandRequest[]) => ModelingDocument;
}

type RequestStatus = "idle" | "connecting" | "streaming" | "complete" | "cancelled" | "error";
type ApprovalMode = "request" | "auto";
type ImageError = "imageCountError" | "imageTypeError" | "imageSizeError" | "imageReadError";

export function AIConversationPanel({
  active,
  document,
  settingsRevision,
  onOpenSettings,
  onPreviewDocument,
  onAcceptProposal,
}: AIConversationPanelProps) {
  const { t } = useTranslation("ai");
  const [provider, setProvider] = useState<AIProviderSettings | null>(null);
  const [settingsError, setSettingsError] = useState<"storageError" | null>(null);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [prompt, setPrompt] = useState("");
  const [approvalMode, setApprovalMode] = useState<ApprovalMode>("request");
  const [images, setImages] = useState<ConversationImage[]>([]);
  const [readingImages, setReadingImages] = useState(false);
  const [imageError, setImageError] = useState<ImageError | null>(null);
  const [status, setStatus] = useState<RequestStatus>("idle");
  const [connectionRetry, setConnectionRetry] = useState<AIConnectionRetry | null>(null);
  const [activeAssistantMessageId, setActiveAssistantMessageId] = useState<number | null>(null);
  const [requestError, setRequestError] = useState<AIRequestErrorKey | null>(null);
  const nextMessageId = useRef(1);
  const abortControllerRef = useRef<AbortController | null>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const readingImagesRef = useRef(false);
  const isBusy = status === "connecting" || status === "streaming";
  const hasInterruptedProposal = messages.some(
    (message) => message.proposalInterrupted && message.proposalStatus === "pending",
  );

  useEffect(() => {
    try {
      setProvider(loadAIProviderSettings());
      setSettingsError(null);
    } catch {
      setProvider(null);
      setSettingsError("storageError");
    }
  }, [settingsRevision, active]);

  useEffect(() => () => abortControllerRef.current?.abort(), []);

  useLayoutEffect(() => {
    const transcript = transcriptRef.current;
    transcript?.querySelectorAll<HTMLOListElement>("[data-ai-proposals]").forEach((list) => {
      list.scrollTop = list.scrollHeight;
    });
    if (transcript) transcript.scrollTop = transcript.scrollHeight;
  }, [messages]);

  async function submitPrompt(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = prompt.trim();
    if ((!text && images.length === 0) || isBusy || readingImagesRef.current || hasInterruptedProposal) return;

    let savedProvider: AIProviderSettings | null;
    try {
      savedProvider = loadAIProviderSettings();
      setProvider(savedProvider);
      setSettingsError(null);
    } catch {
      setProvider(null);
      setSettingsError("storageError");
      setStatus("error");
      setRequestError("reviewSettings");
      return;
    }

    if (!savedProvider) {
      setStatus("idle");
      setRequestError("configureFirst");
      onOpenSettings();
      return;
    }

    const userMessage: ConversationMessage = { id: nextMessageId.current++, role: "user", text, images };
    const assistantMessage = createAssistantMessage();
    const requestMessages = conversationHistory([...messages, userMessage]);

    setPrompt("");
    setImages([]);
    setImageError(null);
    setRequestError(null);
    onPreviewDocument(null);
    setMessages((current) => [...current, userMessage, assistantMessage]);
    await runAssistantTurn(savedProvider, requestMessages, document, assistantMessage, userMessage, approvalMode);
  }

  async function addImages(files: File[]) {
    if (isBusy || readingImagesRef.current || files.length === 0) return;
    const error = validateConversationImages(files, images.length);
    setImageError(error);
    if (error) return;
    readingImagesRef.current = true;
    setReadingImages(true);
    try {
      const attachments = await Promise.all(files.map(readConversationImage));
      setImages((current) => [...current, ...attachments]);
    } catch {
      setImageError("imageReadError");
    } finally {
      readingImagesRef.current = false;
      setReadingImages(false);
    }
  }

  function createAssistantMessage(): ConversationMessage {
    return {
      id: nextMessageId.current++,
      role: "assistant",
      text: "",
      proposals: [],
      proposalStatus: "pending",
    };
  }

  async function runAssistantTurn(
    savedProvider: AIProviderSettings,
    requestMessages: OpenAICompatibleChatMessage[],
    baseDocument: ModelingDocument,
    assistantMessage: ConversationMessage,
    retryMessage: ConversationMessage | undefined,
    mode: ApprovalMode,
    automaticBatches = 0,
  ) {
    setActiveAssistantMessageId(assistantMessage.id);
    setStatus("connecting");
    setConnectionRetry(null);
    const abortController = new AbortController();
    abortControllerRef.current = abortController;
    const proposals: CommandRequest[] = [];
    let acceptingProposals = true;
    let responseText = "";
    const toolCalls = new Map<string, ConversationToolCall>();
    let receivedToolOutput = false;

    function updateToolCall(call: ConversationToolCall) {
      toolCalls.set(call.id, { ...toolCalls.get(call.id), ...call });
      setMessages((current) =>
        current.map((message) =>
          message.id === assistantMessage.id ? { ...message, toolCalls: [...toolCalls.values()] } : message,
        ),
      );
    }

    try {
      const result = streamOpenAICompatibleChat({
        config: {
          baseURL: savedProvider.baseURL,
          modelId: savedProvider.modelId,
          apiKey: savedProvider.apiKey,
        },
        messages: requestMessages,
        tools: createAIModelingTools(baseDocument, {
          onCommandProposal: (request, previewDocument) => {
            if (!acceptingProposals || abortController.signal.aborted) return;
            // Record validated commands with their preview, even if the stream fails before a tool-result arrives.
            proposals.push(request);
            onPreviewDocument(previewDocument);
            setMessages((current) =>
              current.map((message) =>
                message.id === assistantMessage.id ? { ...message, proposals: [...proposals] } : message,
              ),
            );
          },
        }),
        abortSignal: abortController.signal,
        retry: {
          onRetry: (retry) => {
            if (!abortController.signal.aborted) setConnectionRetry(retry);
          },
        },
      });
      let receivedText = false;
      for await (const part of result.fullStream) {
        if (abortController.signal.aborted) break;
        if (part.type === "tool-input-start") {
          updateToolCall({ id: part.id, name: part.toolName, status: "preparing" });
        }
        if (part.type === "tool-call") {
          updateToolCall({ id: part.toolCallId, name: part.toolName, status: "running", input: part.input });
          setStatus("streaming");
        }
        if (part.type === "tool-result") {
          receivedToolOutput = true;
          updateToolCall({
            id: part.toolCallId,
            name: part.toolName,
            status: "completed",
            input: part.input,
            output: part.output,
          });
        }
        if (part.type === "tool-error") {
          updateToolCall({ id: part.toolCallId, name: part.toolName, status: "failed", input: part.input });
        }
        if (part.type === "error") throw part.error;
        if (part.type === "tool-error") throw part.error;
        if (part.type === "text-delta") {
          responseText += part.text;
          if (!receivedText) {
            receivedText = true;
            setStatus("streaming");
          }
          setMessages((current) =>
            current.map((message) =>
              message.id === assistantMessage.id ? { ...message, text: message.text + part.text } : message,
            ),
          );
        }
      }
      if (abortController.signal.aborted) {
        throw abortController.signal.reason ?? new DOMException("Request cancelled.", "AbortError");
      }
      acceptingProposals = false;
      setMessages((current) =>
        current.map((message) => (message.id === assistantMessage.id ? { ...message, proposalReady: true } : message)),
      );
      setStatus("complete");
      if (mode === "auto" && proposals.length > 0) {
        // Keep automatic work bounded; each completed batch remains one undoable edit.
        if (automaticBatches >= 20) {
          setRequestError("autoApprovalLimit");
          return;
        }
        let updatedDocument: ModelingDocument;
        try {
          updatedDocument = onAcceptProposal(proposals);
        } catch {
          setRequestError("applyFailed");
          return;
        }
        onPreviewDocument(null);
        const continuationMessage = createAssistantMessage();
        setMessages((current) =>
          current
            .map((message) =>
              message.id === assistantMessage.id ? { ...message, proposalStatus: "accepted" as const } : message,
            )
            .concat(continuationMessage),
        );
        await runAssistantTurn(
          savedProvider,
          [
            ...requestMessages,
            ...conversationHistory([{ ...assistantMessage, text: responseText }]),
            modelingContinuation,
          ],
          updatedDocument,
          continuationMessage,
          undefined,
          mode,
          automaticBatches + 1,
        );
      }
    } catch (cause) {
      acceptingProposals = false;
      for (const call of toolCalls.values()) {
        if (call.status === "preparing" || call.status === "running") {
          updateToolCall({ ...call, status: abortController.signal.aborted ? "cancelled" : "failed" });
        }
      }
      const retainProposals = !abortController.signal.aborted && proposals.length > 0;
      if (!retainProposals) onPreviewDocument(null);
      setMessages((current) =>
        current
          .filter(
            (message) =>
              message.id !== assistantMessage.id ||
              message.text.trim().length > 0 ||
              retainProposals ||
              toolCalls.size > 0,
          )
          .map((message) =>
            message.id === assistantMessage.id
              ? {
                  ...message,
                  proposals: retainProposals ? [...proposals] : [],
                  proposalStatus: retainProposals ? "pending" : "rejected",
                  proposalReady: retainProposals,
                  proposalInterrupted: retainProposals,
                }
              : message,
          ),
      );
      if (abortController.signal.aborted) {
        setStatus("cancelled");
        setRequestError(null);
      } else {
        if (retryMessage && !responseText.trim() && proposals.length === 0 && !receivedToolOutput) {
          setPrompt(retryMessage.text);
          setImages(retryMessage.images ?? []);
        }
        setStatus("error");
        setRequestError(describeProviderError(cause));
      }
    } finally {
      setConnectionRetry(null);
      setActiveAssistantMessageId((current) => (current === assistantMessage.id ? null : current));
      if (abortControllerRef.current === abortController) abortControllerRef.current = null;
    }
  }

  function cancelRequest() {
    onPreviewDocument(null);
    abortControllerRef.current?.abort(new DOMException("Request cancelled by user.", "AbortError"));
  }

  function acceptProposal(message: ConversationMessage) {
    const proposals = message.proposals ?? [];
    if (isBusy || proposals.length === 0 || message.proposalStatus !== "pending") return;
    if (message.proposalInterrupted) {
      try {
        onAcceptProposal(proposals);
        onPreviewDocument(null);
        setMessages((current) =>
          current.map((item) => (item.id === message.id ? { ...item, proposalStatus: "accepted" } : item)),
        );
      } catch {
        setRequestError("applyFailed");
      }
      // Keeping a failed request's partial work must not send another request automatically.
      return;
    }
    const savedProvider = provider;
    if (!savedProvider) {
      setRequestError("configureContinue");
      return;
    }
    try {
      const updatedDocument = onAcceptProposal(
        proposals.map(({ commandId, arguments: argumentsValue }) => ({
          commandId,
          arguments: argumentsValue,
        })),
      );
      onPreviewDocument(null);
      const continuationMessage = createAssistantMessage();
      const history = conversationHistory(messages);
      setMessages((current) =>
        current
          .map((item) => (item.id === message.id ? { ...item, proposalStatus: "accepted" as const } : item))
          .concat(continuationMessage),
      );
      setRequestError(null);
      void runAssistantTurn(
        savedProvider,
        [...history, modelingContinuation],
        updatedDocument,
        continuationMessage,
        undefined,
        approvalMode,
      );
    } catch {
      setRequestError("applyFailed");
    }
  }

  function rejectProposal(messageId: number) {
    if (isBusy) return;
    onPreviewDocument(null);
    setMessages((current) =>
      current.map((item) => (item.id === messageId ? { ...item, proposalStatus: "rejected" } : item)),
    );
  }

  return (
    <section
      className="ai-conversation flex min-h-0 flex-1 flex-col gap-2.5 overflow-hidden"
      aria-label={t("conversation")}
    >
      <div className="ai-conversation-body flex min-h-0 flex-1 flex-col gap-2.5 overflow-auto px-1 pt-1">
        <div className="ai-conversation-heading flex min-h-10 shrink-0 items-center justify-between border-b border-border px-0.5 pb-2">
          <div className="ai-conversation-provider flex min-w-0 items-center gap-2 text-accent">
            <Bot size={16} />
            <div className="grid min-w-0 gap-0.5">
              <strong className="overflow-hidden text-ellipsis whitespace-nowrap text-[13px] font-semibold text-foreground">
                {provider ? provider.modelId : t("assistant")}
              </strong>
              <span className="overflow-hidden text-ellipsis whitespace-nowrap text-[13px] text-muted">
                {provider ? t("protocolName") : t("notConfigured")}
              </span>
            </div>
          </div>
          <Button
            className="size-11 rounded-md text-muted hover:bg-soft"
            variant="ghost"
            size="icon-sm"
            aria-label={t("openSettings")}
            title={t("providerSettings")}
            onClick={onOpenSettings}
          >
            <Settings2 />
          </Button>
        </div>

        {settingsError && (
          <p className="m-0 shrink-0 break-words text-[13px] leading-[1.4] text-destructive" role="alert">
            {t("storageError")}
          </p>
        )}

        <div
          className="ai-transcript flex min-h-20 flex-1 flex-col items-stretch gap-2.5 overflow-auto px-px py-0.5"
          ref={transcriptRef}
          aria-label={t("messages")}
          aria-live="polite"
        >
          {messages.length === 0 ? (
            <div className="ai-conversation-empty grid flex-1 content-center justify-items-center gap-2 text-center text-muted">
              <Bot size={20} />
              <p className="m-0 max-w-[180px] text-[13px]">{t("empty")}</p>
            </div>
          ) : (
            messages.map((message) => (
              <article
                className={`ai-message max-w-[94%] self-start rounded-md border border-border bg-sheet px-[9px] py-2 ${message.role === "user" ? "self-end border-border bg-accent-soft" : ""}`}
                key={message.id}
              >
                <span className="text-[13px] text-muted">
                  {message.role === "user" ? t("you") : t("assistantRole")}
                </span>
                {message.images?.length ? <AIImageAttachments images={message.images} /> : null}
                <p className="mt-1 mb-0 break-words whitespace-pre-wrap text-[13px] leading-6 text-foreground">
                  {message.text ||
                    (isBusy && message.id === activeAssistantMessageId ? (
                      <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" />
                    ) : (
                      ""
                    ))}
                </p>
                {message.toolCalls?.length ? <AIToolCalls calls={message.toolCalls} /> : null}
                {message.proposals && message.proposals.length > 0 && (
                  <section className="mt-2 grid gap-2 border-t border-border pt-2" aria-label={t("proposal")}>
                    <strong className="text-[13px] text-foreground">
                      {t("preview", { count: message.proposals.length })}
                    </strong>
                    <ol data-ai-proposals className="m-0 grid max-h-36 gap-1 overflow-auto pl-5 text-[13px] text-muted">
                      {message.proposals.map((proposal, index) => (
                        <li key={`${message.id}-${index}`}>
                          <span className="font-semibold text-foreground">{commandLabel(proposal.commandId)}</span>
                          <code className="mt-0.5 block break-all">{JSON.stringify(proposal.arguments)}</code>
                        </li>
                      ))}
                    </ol>
                    {message.proposalInterrupted && message.proposalStatus === "pending" && (
                      <p className="m-0 text-[13px] leading-[1.4] text-muted">{t("interruptedProposal")}</p>
                    )}
                    {message.proposalStatus === "pending" && message.proposalReady && (
                      <div className="flex gap-1.5">
                        <Button
                          className="h-7 flex-1 rounded-md text-[13px]"
                          size="sm"
                          disabled={isBusy}
                          onClick={() => acceptProposal(message)}
                        >
                          <Check />
                          {t(message.proposalInterrupted ? "keepChanges" : "accept")}
                        </Button>
                        <Button
                          className="h-7 rounded-md text-[13px]"
                          size="sm"
                          variant="outline"
                          disabled={isBusy}
                          onClick={() => rejectProposal(message.id)}
                        >
                          <X />
                          {t(message.proposalInterrupted ? "discardChanges" : "reject")}
                        </Button>
                      </div>
                    )}
                    {message.proposalStatus === "rejected" && (
                      <span className="text-[13px] text-muted" role="status">
                        {t("rejected")}
                      </span>
                    )}
                  </section>
                )}
              </article>
            ))
          )}
        </div>

        <div
          className="ai-request-status flex min-h-[17px] shrink-0 items-center gap-1.5 text-[13px] text-muted"
          role="status"
          aria-live="polite"
        >
          <span
            className={`ai-status-indicator size-[7px] shrink-0 rounded-full ${status === "connecting" || status === "streaming" ? "bg-warning" : status === "complete" ? "bg-positive" : status === "error" ? "bg-destructive" : "bg-muted"}`}
          />
          {connectionRetry &&
            t("reconnecting", { attempt: connectionRetry.attempt, maxRetries: connectionRetry.maxRetries })}
          {!connectionRetry && status === "connecting" && t("connecting")}
          {!connectionRetry && status === "streaming" && t("streaming")}
          {status === "complete" && t("complete")}
          {status === "cancelled" && t("cancelled")}
          {status === "error" && t("error")}
          {status === "idle" && t("idle")}
        </div>
        {isBusy && (
          <Button
            className="h-7 shrink-0 self-start rounded-md text-[13px]"
            type="button"
            size="sm"
            variant="outline"
            onClick={cancelRequest}
          >
            <X />
            {t("cancelRequest")}
          </Button>
        )}
        {requestError && (
          <div className="grid shrink-0 gap-1.5 break-words text-[13px] leading-[1.4] text-destructive" role="alert">
            <span>{t(requestError)}</span>
            {status === "error" && !hasInterruptedProposal && <span className="text-muted">{t("retry")}</span>}
          </div>
        )}
      </div>

      <form
        className="ai-prompt-form flex shrink-0 flex-col gap-1.5 border-t border-border px-1 pt-[9px] pb-1"
        onSubmit={submitPrompt}
      >
        <div className="flex w-full items-center justify-between gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button type="button" variant="ghost" size="sm" className="text-[13px]" />}
              aria-label={t("approvalMode")}
              disabled={isBusy}
            >
              {t(approvalMode === "request" ? "requestApproval" : "autoApproval")}
              <ChevronDown className="size-3.5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent side="top" aria-label={t("approvalMode")}>
              <DropdownMenuRadioGroup
                value={approvalMode}
                onValueChange={(value) => {
                  if (value === "request" || value === "auto") setApprovalMode(value);
                }}
              >
                <DropdownMenuRadioItem value="request">{t("requestApproval")}</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="auto">{t("autoApproval")}</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
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
              void addImages(files);
            }}
          />
        </div>
        {images.length > 0 && (
          <AIImageAttachments
            images={images}
            onRemove={
              isBusy || readingImages
                ? undefined
                : (id) => {
                    setImages((current) => current.filter((image) => image.id !== id));
                    setImageError(null);
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
            id="ai-prompt"
            className="h-11 rounded-[5px] text-[13px]"
            value={prompt}
            onChange={(event) => setPrompt(event.currentTarget.value)}
            placeholder={t("placeholder")}
            autoComplete="off"
            disabled={isBusy}
          />
          <Button
            className="size-11 rounded-[5px]"
            type="submit"
            size="icon"
            aria-label={t("send")}
            title={t("send")}
            disabled={(!prompt.trim() && images.length === 0) || isBusy || readingImages || hasInterruptedProposal}
          >
            <Send />
          </Button>
        </div>
      </form>
    </section>
  );
}

type AIRequestErrorKey =
  | "autoApprovalLimit"
  | "reviewSettings"
  | "configureFirst"
  | "configureContinue"
  | "applyFailed"
  | "authError"
  | "networkError"
  | "protocolError"
  | "requestFailed";

function describeProviderError(cause: unknown): AIRequestErrorKey {
  const message =
    cause instanceof Error
      ? cause.message
      : typeof cause === "object" && cause !== null && "message" in cause && typeof cause.message === "string"
        ? cause.message
        : "The provider returned an incompatible response. Check that streamed tool calls match the configured protocol.";
  const normalized = message.toLowerCase();

  if (normalized.includes("401") || normalized.includes("403") || normalized.includes("unauthorized")) {
    return "authError";
  }
  if (normalized.includes("cors") || normalized.includes("failed to fetch") || normalized.includes("network")) {
    return "networkError";
  }
  if (
    normalized.includes("tool") ||
    normalized.includes("schema") ||
    normalized.includes("protocol") ||
    normalized.includes("incompatible") ||
    normalized.includes("invalid input") ||
    normalized.includes("validation")
  ) {
    return "protocolError";
  }
  return "requestFailed";
}