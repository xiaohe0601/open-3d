import { useTranslation } from "react-i18next";
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { Bot, Check, LoaderCircle, Send, Settings2, X } from "lucide-react";
import { streamOpenAICompatibleChat } from "@open-3d/ai";
import { createAIModelingTools, type AIModelingToolResult } from "@open-3d/ai";
import type { OpenAICompatibleChatMessage } from "@open-3d/ai";
import { loadAIProviderSettings } from "@open-3d/ai/settings";
import type { AIProviderSettings } from "@open-3d/ai/settings";
import { commandLabel } from "./localization";
import type { CommandRequest, ModelingDocument } from "@open-3d/model-core";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";

interface AIConversationPanelProps {
  active: boolean;
  document: ModelingDocument;
  settingsRevision: number;
  onOpenSettings: () => void;
  onPreviewDocument: (document: ModelingDocument | null) => void;
  onAcceptProposal: (commands: readonly CommandRequest[]) => ModelingDocument;
}

interface CommandProposal {
  commandId: string;
  arguments: Record<string, unknown>;
}

interface ConversationMessage {
  id: number;
  role: "user" | "assistant";
  text: string;
  proposals?: CommandProposal[];
  proposalStatus?: "pending" | "accepted" | "rejected";
  proposalReady?: boolean;
}

type RequestStatus = "idle" | "connecting" | "streaming" | "complete" | "cancelled" | "error";

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
  const [status, setStatus] = useState<RequestStatus>("idle");
  const [requestError, setRequestError] = useState<AIRequestErrorKey | null>(null);
  const nextMessageId = useRef(1);
  const abortControllerRef = useRef<AbortController | null>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const isBusy = status === "connecting" || status === "streaming";

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
    if (!text || isBusy) return;

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

    const userMessage: ConversationMessage = { id: nextMessageId.current++, role: "user", text };
    const assistantMessage = createAssistantMessage();
    const history = messages
      .filter((message) => message.text.length > 0)
      .map(({ role, text: content }) => ({ role, content }) as OpenAICompatibleChatMessage);
    const requestMessages: OpenAICompatibleChatMessage[] = [...history, { role: "user", content: text }];

    setPrompt("");
    setRequestError(null);
    onPreviewDocument(null);
    setMessages((current) => [...current, userMessage, assistantMessage]);
    await runAssistantTurn(savedProvider, requestMessages, document, assistantMessage, text);
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
    retryPrompt: string,
  ) {
    setStatus("connecting");
    const abortController = new AbortController();
    abortControllerRef.current = abortController;

    try {
      const result = streamOpenAICompatibleChat({
        config: {
          baseURL: savedProvider.baseURL,
          modelId: savedProvider.modelId,
          apiKey: savedProvider.apiKey,
        },
        messages: requestMessages,
        tools: createAIModelingTools(baseDocument, {
          onCommandProposal: (_request, previewDocument) => {
            if (!abortController.signal.aborted) onPreviewDocument(previewDocument);
          },
        }),
        abortSignal: abortController.signal,
      });
      let receivedText = false;
      const proposals: CommandProposal[] = [];
      for await (const part of result.fullStream) {
        if (abortController.signal.aborted) break;
        if (part.type === "error") throw part.error;
        if (part.type === "tool-error") throw part.error;
        if (part.type === "text-delta") {
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
        if (part.type === "tool-result" && isCommandProposal(part.output)) {
          proposals.push({ commandId: part.output.commandId, arguments: part.output.arguments });
          setMessages((current) =>
            current.map((message) =>
              message.id === assistantMessage.id ? { ...message, proposals: [...proposals] } : message,
            ),
          );
        }
      }
      if (abortController.signal.aborted) {
        throw abortController.signal.reason ?? new DOMException("Request cancelled.", "AbortError");
      }
      setMessages((current) =>
        current.map((message) => (message.id === assistantMessage.id ? { ...message, proposalReady: true } : message)),
      );
      setStatus("complete");
    } catch (cause) {
      if (abortController.signal.aborted) {
        onPreviewDocument(null);
        setMessages((current) =>
          current.map((message) =>
            message.id === assistantMessage.id
              ? { ...message, proposals: [], proposalStatus: "rejected", proposalReady: false }
              : message,
          ),
        );
        setStatus("cancelled");
        setRequestError(null);
      } else {
        onPreviewDocument(null);
        setMessages((current) =>
          current.map((message) =>
            message.id === assistantMessage.id
              ? { ...message, proposals: [], proposalStatus: "rejected", proposalReady: false }
              : message,
          ),
        );
        setPrompt(retryPrompt);
        setStatus("error");
        setRequestError(describeProviderError(cause));
      }
    } finally {
      if (abortControllerRef.current === abortController) abortControllerRef.current = null;
    }
  }

  function cancelRequest() {
    onPreviewDocument(null);
    abortControllerRef.current?.abort(new DOMException("Request cancelled by user.", "AbortError"));
  }

  function acceptProposal(message: ConversationMessage) {
    const proposals = message.proposals ?? [];
    if (proposals.length === 0 || message.proposalStatus !== "pending") return;
    try {
      const updatedDocument = onAcceptProposal(
        proposals.map(({ commandId, arguments: argumentsValue }) => ({
          commandId,
          arguments: argumentsValue,
        })),
      );
      onPreviewDocument(null);
      const continuationMessage = createAssistantMessage();
      const history = messages
        .filter((item) => item.text.length > 0)
        .map(({ role, text }) => ({ role, content: text }) as OpenAICompatibleChatMessage);
      const continuation: OpenAICompatibleChatMessage = {
        role: "user",
        content:
          "Continue the original modeling task using the current scene. The user approved and applied the proposed changes above. " +
          "Do not repeat completed work. If the original task is complete, briefly confirm completion. " +
          "Otherwise, continue by proposing the next necessary modeling changes for review.",
      };
      setMessages((current) =>
        current
          .map((item) => (item.id === message.id ? { ...item, proposalStatus: "accepted" as const } : item))
          .concat(continuationMessage),
      );
      setRequestError(null);
      const savedProvider = provider;
      if (!savedProvider) {
        setStatus("error");
        setRequestError("configureContinue");
        return;
      }
      void runAssistantTurn(
        savedProvider,
        [...history, continuation],
        updatedDocument,
        continuationMessage,
        messages.find((item) => item.role === "user")?.text ?? "",
      );
    } catch {
      setRequestError("applyFailed");
    }
  }

  function rejectProposal(messageId: number) {
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
                <p className="mt-1 mb-0 break-words whitespace-pre-wrap text-[13px] leading-6 text-foreground">
                  {message.text ||
                    (isBusy && message.role === "assistant" ? (
                      <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" />
                    ) : (
                      ""
                    ))}
                </p>
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
                    {message.proposalStatus === "pending" && message.proposalReady && (
                      <div className="flex gap-1.5">
                        <Button
                          className="h-7 flex-1 rounded-md text-[13px]"
                          size="sm"
                          onClick={() => acceptProposal(message)}
                        >
                          <Check />
                          {t("accept")}
                        </Button>
                        <Button
                          className="h-7 rounded-md text-[13px]"
                          size="sm"
                          variant="outline"
                          onClick={() => rejectProposal(message.id)}
                        >
                          <X />
                          {t("reject")}
                        </Button>
                      </div>
                    )}
                    {message.proposalStatus === "accepted" && (
                      <span className="text-[13px] text-positive" role="status">
                        {t("applied")}
                      </span>
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
          {status === "connecting" && t("connecting")}
          {status === "streaming" && t("streaming")}
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
            <span className="text-muted">{t("retry")}</span>
          </div>
        )}
      </div>

      <form
        className="ai-prompt-form flex shrink-0 items-center gap-1.5 border-t border-border px-1 pt-[9px] pb-1"
        onSubmit={submitPrompt}
      >
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
          disabled={!prompt.trim() || isBusy}
        >
          <Send />
        </Button>
      </form>
    </section>
  );
}

function isCommandProposal(value: unknown): value is Extract<AIModelingToolResult, { kind: "command-proposal" }> {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    value.kind === "command-proposal" &&
    "commandId" in value &&
    typeof value.commandId === "string" &&
    "arguments" in value &&
    typeof value.arguments === "object" &&
    value.arguments !== null
  );
}

type AIRequestErrorKey =
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