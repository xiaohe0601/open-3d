import type { ModraActivity } from "../modra/components/launcher-robot";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { Settings2, Square } from "lucide-react";
import { loadAIProviderSettings } from "@open-3d/ai/settings";
import type { AIProviderSettings } from "@open-3d/ai/settings";
import { ModraContextError, type ObjectReference } from "@open-3d/ai/runtime";
import { useModraController } from "../modra/controller/use-modra-controller";
import type { WorkspaceModelingHost } from "../modra/controller/workspace-host";
import { Button } from "../components/ui/button";

import {
  readConversationImage,
  MAX_CONVERSATION_IMAGES,
  validateConversationImages,
  type ConversationImage,
  type ConversationMessage,
} from "./ai-conversation-message";
import { conversationMessages } from "../modra/controller/presentation";
import { ModraSessionManager } from "../modra/components/session-manager";
import { ModraComposer } from "../modra/components/composer";
import { ModraTranscript } from "../modra/components/transcript";
import { GatewayChallenge } from "../modra/components/gateway-challenge";
import { officialTurnstileSiteKey } from "../modra/controller/official-gateway";
import { ObjectReferenceActions, ObjectReferenceChips } from "../modra/components/object-references";
import { Camera } from "lucide-react";
import { ModraTaskQueue } from "../modra/components/task-queue";
import { ModraContextUsage } from "../modra/components/context-usage";

interface AIConversationPanelProps {
  active: boolean;
  onActivityChange?: (activity: ModraActivity) => void;
  headerTarget?: HTMLElement | null;
  modelingHost: WorkspaceModelingHost;
  settingsRevision: number;
  onOpenSettings: () => void;
}

type RequestStatus = "idle" | "connecting" | "streaming" | "complete" | "cancelled" | "error";
type ApprovalMode = "request" | "auto";
type ImageError = "imageCountError" | "imageTypeError" | "imageSizeError" | "imageReadError";

const providerErrorKeys = {
  "context-reference": "contextReferenceError",
  "context-limit": "contextLimitError",
  "output-limit": "outputLimitError",
  auth: "authError",
  rate: "rateError",
  "gateway-auth": "gatewayAuthError",
  "gateway-challenge": "gatewayChallengeError",
  "gateway-policy": "gatewayPolicyError",
  "gateway-rate": "gatewayRateError",
  "gateway-quota": "gatewayQuotaError",
  "gateway-size": "gatewaySizeError",
  "gateway-configuration": "gatewayConfigurationError",
  "gateway-incompatible": "gatewayIncompatibleError",
  "gateway-unavailable": "gatewayUnavailableError",
  network: "networkError",
  protocol: "protocolError",
  "unsupported-images": "unsupportedImages",
  "unsupported-tools": "unsupportedTools",
} as const;

export function AIConversationPanel({
  active,
  onActivityChange,
  headerTarget,
  modelingHost,
  settingsRevision,
  onOpenSettings,
}: AIConversationPanelProps) {
  const { t } = useTranslation("ai");
  const [provider, setProvider] = useState<AIProviderSettings | null>(null);
  const [settingsError, setSettingsError] = useState<"storageError" | null>(null);
  const controller = useModraController(modelingHost, settingsRevision);
  const {
    runtime,
    state,
    assets,
    attach,
    gatewayChallenge,
    ready,
    readOnly,
    durability,
    storageError,
    initialDraft,
    saveDraft,
    continueInMemory,
  } = controller;
  const messages = conversationMessages(state, assets);
  const run = state.run;
  const [prompt, setPrompt] = useState("");
  const [approvalMode, setApprovalMode] = useState<ApprovalMode>("request");
  const [taskMode, setTaskMode] = useState<"plan" | "build">("build");
  const [images, setImages] = useState<ConversationImage[]>([]);
  const [references, setReferences] = useState<ObjectReference[]>([]);
  const [readingImages, setReadingImages] = useState(false);
  const [imageError, setImageError] = useState<ImageError | null>(null);
  const [captureError, setCaptureError] = useState(false);
  const composerRef = useRef<HTMLInputElement>(null);
  const [hydratedSession, setHydratedSession] = useState<string | null>(null);
  const [draftError, setDraftError] = useState(false);
  const [dispatching, setDispatching] = useState(false);
  const [queueSaving, setQueueSaving] = useState(false);
  const currentRuntime = useRef(runtime);
  currentRuntime.current = runtime;
  const draftRevision = useRef(0);
  const usable = ready && hydratedSession === state.id;
  useLayoutEffect(() => {
    if (!ready) return;
    setPrompt(initialDraft.text);
    setImages([...initialDraft.images]);
    setReferences([...(initialDraft.references ?? [])]);
    setHydratedSession(state.id);
    setApprovalMode("request");
    setTaskMode("build");
    setDraftError(false);
    setDispatching(false);
    setQueueSaving(false);
    setRequestError(null);
    setImageError(null);
    setCaptureError(false);
    readingImagesRef.current = false;
    setReadingImages(false);
    draftRevision.current += 1;
  }, [state.id, ready, initialDraft]);
  useEffect(() => {
    if (!ready || readOnly || hydratedSession !== state.id) return;
    let active = true;
    void saveDraft({ text: prompt, images, references }).then(
      () => active && setDraftError(false),
      () => active && setDraftError(true),
    );
    return () => {
      active = false;
    };
  }, [prompt, images, references, ready, readOnly, hydratedSession, state.id, saveDraft]);
  const status: RequestStatus = !run
    ? "idle"
    : run.phase === "retrying"
      ? "connecting"
      : run.phase === "awaiting-review"
        ? run.outcome === "failed"
          ? "error"
          : "complete"
        : run.phase === "completed" || run.phase === "continuing"
          ? "complete"
          : run.phase === "failed" || run.phase === "stale"
            ? "error"
            : run.phase;
  const connectionRetry = run?.retry;
  const responding = run && ["connecting", "streaming", "retrying", "continuing"].includes(run.phase);
  const activeAssistantMessageId = responding ? run.messageId : undefined;
  const [localError, setRequestError] = useState<AIRequestErrorKey | null>(null);
  const requestError =
    localError ??
    (run?.phase === "stale"
      ? "staleProposal"
      : run?.error === "batch-limit"
        ? "autoApprovalLimit"
        : run?.outcome === "failed"
          ? (providerErrorKeys[run.error as keyof typeof providerErrorKeys] ?? "requestFailed")
          : null);
  const readingImagesRef = useRef(false);
  const isBusy = dispatching || status === "connecting" || status === "streaming" || run?.phase === "continuing";
  const activity: ModraActivity = isBusy
    ? "generating"
    : requestError
      ? "error"
      : status === "complete"
        ? "completed"
        : "idle";
  useEffect(() => {
    onActivityChange?.(activity);
  }, [activity, onActivityChange]);
  const hasInterruptedProposal = messages.some(
    (message) => message.proposalInterrupted && message.proposalStatus === "pending",
  );
  const queueing = isBusy || run?.phase === "awaiting-review" || !!state.queue?.entries.length;

  useEffect(() => {
    try {
      setProvider(loadAIProviderSettings());
      setSettingsError(null);
    } catch {
      setProvider(null);
      setSettingsError("storageError");
    }
  }, [settingsRevision, active]);

  async function submitPrompt(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = prompt.trim();
    await sendPrompt(text, images, references, taskMode, true);
  }

  async function sendPrompt(
    text: string,
    submittedImages: ConversationImage[],
    submittedReferences: ObjectReference[],
    mode: "plan" | "build",
    clearDraft: boolean,
  ) {
    if (
      !usable ||
      readOnly ||
      (!text && submittedImages.length === 0) ||
      queueSaving ||
      readingImagesRef.current ||
      (!clearDraft && queueing)
    )
      return;

    if (submittedImages.length > MAX_CONVERSATION_IMAGES) {
      setImageError("imageCountError");
      return;
    }

    let savedProvider: AIProviderSettings | null;
    try {
      savedProvider = loadAIProviderSettings();
      setProvider(savedProvider);
      setSettingsError(null);
    } catch {
      setProvider(null);
      setSettingsError("storageError");
      setRequestError("reviewSettings");
      return;
    }

    if (!savedProvider) {
      setRequestError("configureFirst");
      onOpenSettings();
      return;
    }

    const previousSequence = state.lastSequence;
    const previousMessageCount = state.messages.length;
    const submittedRevision = ++draftRevision.current;
    const mayRestore = () =>
      clearDraft && currentRuntime.current === runtime && draftRevision.current === submittedRevision;
    if (clearDraft) {
      setPrompt("");
      setImages([]);
      setReferences([]);
    }
    setImageError(null);
    setRequestError(null);
    const queued = clearDraft && queueing;
    if (queued) setQueueSaving(true);
    else setDispatching(true);
    try {
      const input = {
        text,
        assets: attach(submittedImages),
        references: submittedReferences,
        approval: approvalMode,
        mode,
        connection: {
          providerId: "configured",
          protocol: savedProvider.protocol,
          route: savedProvider.route,
          configuration: {
            baseURL: savedProvider.baseURL,
            modelId: savedProvider.modelId,
            ...(savedProvider.contextWindowTokens ? { contextWindowTokens: savedProvider.contextWindowTokens } : {}),
            ...(savedProvider.route === "self-hosted" ? { gatewayURL: savedProvider.gatewayURL } : {}),
          },
        },
      };
      if (queued) {
        await runtime.enqueue(input);
        return;
      }
      await runtime.submit(input);
      const finished = runtime.getSnapshot();
      const submittedUser = finished.messages[previousMessageCount];
      const submittedRun = finished.runs.find((item) => item.taskId === submittedUser?.taskId);
      const firstReply = finished.messages.find(
        (item) => item.role === "assistant" && item.taskId === submittedUser?.taskId,
      );
      const meaningful = finished.messages.some(
        (item) =>
          item.role === "assistant" &&
          item.taskId === submittedUser?.taskId &&
          (item.text.trim() || item.changeSetId || item.toolCalls.some((call) => call.status === "completed")),
      );
      if (
        mayRestore() &&
        submittedRun?.outcome === "failed" &&
        finished.lastSequence > previousSequence &&
        !meaningful &&
        (!firstReply || firstReply.runId === submittedRun.id)
      ) {
        setPrompt(text);
        setImages(submittedImages);
        setReferences(submittedReferences);
      }
    } catch (error) {
      if (mayRestore() && (queued || runtime.getSnapshot().lastSequence === previousSequence)) {
        setPrompt(text);
        setImages(submittedImages);
        setReferences(submittedReferences);
      }
      if (currentRuntime.current === runtime)
        setRequestError(error instanceof ModraContextError ? providerErrorKeys[error.code] : "requestFailed");
    } finally {
      if (currentRuntime.current === runtime) {
        if (queued) setQueueSaving(false);
        else setDispatching(false);
      }
    }
  }

  async function addImages(files: File[]) {
    if (!usable || readOnly || readingImagesRef.current || files.length === 0) return;
    const error = validateConversationImages(files, images.length);
    setImageError(error);
    if (error) return;
    readingImagesRef.current = true;
    setReadingImages(true);
    try {
      const attachments = await Promise.all(files.map(readConversationImage));
      if (currentRuntime.current === runtime) {
        draftRevision.current += 1;
        setImages((current) => [...current, ...attachments]);
      }
    } catch {
      if (currentRuntime.current === runtime) setImageError("imageReadError");
    } finally {
      if (currentRuntime.current === runtime) {
        readingImagesRef.current = false;
        setReadingImages(false);
      }
    }
  }

  async function captureViewport() {
    if (!usable || readOnly || readingImagesRef.current) return;
    const version = modelingHost.snapshot().version;
    const revision = draftRevision.current;
    readingImagesRef.current = true;
    setReadingImages(true);
    setCaptureError(false);
    try {
      const blob = await modelingHost.captureViewport();
      const file = new File([blob], "viewport.jpg", { type: blob.type });
      const error = validateConversationImages([file], images.length);
      if (error) {
        if (currentRuntime.current === runtime) setImageError(error);
        return;
      }
      const image = await readConversationImage(file);
      const current = modelingHost.snapshot().version;
      if (
        currentRuntime.current === runtime &&
        revision === draftRevision.current &&
        current.scopeId === version.scopeId &&
        current.generationId === version.generationId
      ) {
        draftRevision.current += 1;
        setImages((previous) => [...previous, image]);
        setImageError(null);
      }
    } catch {
      if (currentRuntime.current === runtime) setCaptureError(true);
    } finally {
      if (currentRuntime.current === runtime) {
        readingImagesRef.current = false;
        setReadingImages(false);
      }
    }
  }

  function cancelRequest() {
    runtime.cancel();
  }
  function acceptProposal(message: ConversationMessage) {
    if (!usable || readOnly || isBusy || !message.changeSetId) return;
    setRequestError(null);
    setDispatching(true);
    void runtime
      .accept(message.changeSetId)
      .catch(() => {
        if (currentRuntime.current === runtime) setRequestError("applyFailed");
      })
      .finally(() => {
        if (currentRuntime.current === runtime) setDispatching(false);
      });
  }
  function rejectProposal(messageId: string | number) {
    const message = messages.find((item) => item.id === messageId);
    if (!readOnly && message?.changeSetId)
      void Promise.resolve(runtime.reject(message.changeSetId)).catch(() => {
        if (currentRuntime.current === runtime) setRequestError("applyFailed");
      });
  }

  const heading = (
    <div className="ai-conversation-heading flex min-w-0 w-full shrink-0 items-center justify-between gap-1">
      <ModraSessionManager
        controller={controller}
        draft={{ text: prompt, images, references }}
        needsStop={isBusy || run?.phase === "awaiting-review" || durability === "memory"}
      />
      <Button
        className="ai-conversation-provider h-9 min-w-[10rem] max-w-[44%] shrink gap-1 px-1.5 text-muted"
        variant="ghost"
        aria-label={t("openSettings")}
        title={
          provider
            ? `${provider.modelId} · ${t(`protocolNames.${provider.protocol}`)} · ${t(`routes.${provider.route}`)}`
            : t("providerSettings")
        }
        onClick={onOpenSettings}
      >
        <span className="truncate text-[13px] font-normal">{provider ? provider.modelId : t("notConfigured")}</span>
        <Settings2 className="size-4 shrink-0" />
      </Button>
    </div>
  );
  return (
    <section
      data-modra-busy={isBusy ? "true" : "false"}
      data-modra-ready={usable ? "true" : "false"}
      data-modra-durability={durability}
      className="ai-conversation flex min-h-0 flex-1 flex-col gap-2.5 overflow-hidden"
      aria-label={t("conversation")}
    >
      {headerTarget ? createPortal(heading, headerTarget) : heading}
      <div className="ai-conversation-body flex min-h-0 flex-1 flex-col gap-2.5 overflow-x-hidden overflow-y-auto px-1">
        {settingsError && (
          <p className="m-0 shrink-0 break-words text-[13px] leading-[1.4] text-destructive" role="alert">
            {t("storageError")}
          </p>
        )}
        {!ready ? (
          <p role="status" className="m-0 text-[13px] text-muted">
            {t("sessionLoading")}
          </p>
        ) : readOnly || durability === "memory" || durability === "error" || draftError || storageError ? (
          <div className="grid shrink-0 gap-1 rounded-md bg-soft p-2 text-[13px] text-muted" role="status">
            <span>
              {t(readOnly ? "sessionReadOnly" : durability === "memory" ? "sessionMemory" : "sessionSaveError")}
            </span>
            {storageError && (
              <span>
                {t(
                  storageError === "newer-version"
                    ? "sessionNewerVersion"
                    : storageError === "corrupt"
                      ? "sessionCorrupt"
                      : "sessionStorageUnavailable",
                )}
              </span>
            )}
            {(durability === "error" || draftError) && !readOnly && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="justify-self-start"
                onClick={() => {
                  void controller.retryPersistence({ text: prompt, images, references }).then(
                    () => setDraftError(false),
                    () => setDraftError(true),
                  );
                }}
              >
                {t("sessionRetrySave")}
              </Button>
            )}
            {(readOnly || durability === "error" || draftError) && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="justify-self-start"
                onClick={() => continueInMemory({ text: prompt, images, references })}
              >
                {t("sessionContinueMemory")}
              </Button>
            )}
          </div>
        ) : null}

        <ModraTranscript
          buildFromPlan={(message) => {
            if (!message.plan) return;
            setTaskMode("build");
            void sendPrompt(
              "Build the following plan using the current scene. This plan is intent, not approval or previously applied work.\n" +
                message.plan.steps.map((step) => `${step.id}: ${step.label}`).join("\n"),
              [],
              [],
              "build",
              false,
            );
          }}
          key={state.id}
          active={active}
          messages={messages}
          isBusy={isBusy || readOnly || !usable}
          activeAssistantMessageId={activeAssistantMessageId}
          acceptProposal={acceptProposal}
          rejectProposal={rejectProposal}
        />

        <div className="ai-request-status flex min-h-[20px] shrink-0 items-center justify-between gap-2 text-xs text-muted">
          <span className="flex min-w-0 items-center gap-1.5" role="status" aria-live="polite">
            <span
              className={`ai-status-indicator size-[7px] shrink-0 rounded-full ${status === "connecting" || status === "streaming" ? "bg-warning" : status === "complete" ? "bg-positive" : status === "error" ? "bg-destructive" : "bg-muted"}`}
            />
            {connectionRetry &&
              t("reconnecting", { attempt: connectionRetry.attempt, maxRetries: connectionRetry.maxRetries })}
            {!connectionRetry && status === "connecting" && t(run?.compacting ? "contextCompacting" : "connecting")}
            {!connectionRetry && status === "streaming" && t("streaming")}
            {status === "complete" && t("complete")}
            {status === "cancelled" && t("cancelled")}
            {status === "error" && t("error")}
            {status === "idle" && t("idle")}
          </span>
          {responding && !readOnly && (
            <Button
              className="size-6 shrink-0 rounded-md"
              type="button"
              size="icon"
              variant="ghost"
              aria-label={t("cancelRequest")}
              title={t("cancelRequest")}
              onClick={cancelRequest}
            >
              <Square className="size-3 fill-current" />
            </Button>
          )}
        </div>
        {requestError && (
          <div className="grid shrink-0 gap-1.5 break-words text-[13px] leading-[1.4] text-destructive" role="alert">
            <span>{t(requestError)}</span>
          </div>
        )}
      </div>

      <ModraTaskQueue
        queue={state.queue}
        disabled={!usable || readOnly || queueSaving}
        canResume={!isBusy && run?.phase !== "awaiting-review"}
        onRemove={(id) => void runtime.removeQueued(id).catch(() => setRequestError("queueDispatchError"))}
        onPause={() => runtime.pauseQueue()}
        onResume={() => {
          setDispatching(true);
          void runtime
            .resumeQueue()
            .catch(() => setRequestError("queueDispatchError"))
            .finally(() => {
              if (currentRuntime.current === runtime) setDispatching(false);
            });
        }}
      />
      <ModraComposer
        queueing={queueing}
        queueSaving={queueSaving}
        taskMode={taskMode}
        onTaskMode={setTaskMode}
        contextActions={
          <>
            <ModraContextUsage
              state={state}
              protocol={provider?.protocol ?? "openai-compatible"}
              configured={provider?.contextWindowTokens}
              host={modelingHost}
              mode={isBusy && run ? run.mode : taskMode}
              draft={prompt}
              imageCount={images.length}
              referenceCount={references.length}
              busy={isBusy}
            />
            <ObjectReferenceActions
              host={modelingHost}
              references={references}
              disabled={readOnly || !usable}
              onChange={(next) => {
                draftRevision.current += 1;
                setReferences(next);
                setRequestError(null);
              }}
            />
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-label={t("captureViewport")}
              title={t("captureViewport")}
              disabled={readOnly || !usable || readingImages || images.length >= MAX_CONVERSATION_IMAGES}
              onClick={() => void captureViewport()}
            >
              <Camera />
            </Button>
          </>
        }
        referenceChips={
          references.length ? (
            <ObjectReferenceChips
              references={references}
              onRemove={
                readOnly || !usable
                  ? undefined
                  : (id) => {
                      draftRevision.current += 1;
                      setReferences((current) => current.filter((ref) => ref.id !== id));
                    }
              }
            />
          ) : null
        }
        inputRef={composerRef}
        prompt={prompt}
        approvalMode={approvalMode}
        images={images}
        readingImages={readingImages}
        imageError={imageError}
        isBusy={readOnly || !usable}
        submitPrompt={(event) => void submitPrompt(event)}
        onPrompt={(text) => {
          draftRevision.current += 1;
          setPrompt(text);
        }}
        onApprovalMode={setApprovalMode}
        onAddImages={(files) => void addImages(files)}
        onRemoveImage={(id) => {
          draftRevision.current += 1;
          setImages((current) => current.filter((image) => image.id !== id));
          setImageError(null);
        }}
      />
      {captureError && (
        <p className="m-0 text-[13px] text-destructive" role="alert">
          {t("captureViewportError")}
        </p>
      )}
      <GatewayChallenge request={gatewayChallenge} siteKey={officialTurnstileSiteKey} />
    </section>
  );
}

type AIRequestErrorKey =
  | "contextLimitError"
  | "outputLimitError"
  | "queueDispatchError"
  | "contextReferenceError"
  | "staleProposal"
  | "autoApprovalLimit"
  | "reviewSettings"
  | "configureFirst"
  | "configureContinue"
  | "applyFailed"
  | "authError"
  | "networkError"
  | "protocolError"
  | "requestFailed";