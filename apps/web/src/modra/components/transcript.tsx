import { useTranslation } from "react-i18next";
import { ArrowDown, Bot, LoaderCircle } from "lucide-react";
import { useTranscriptScroll } from "./use-transcript-scroll";
import { Button } from "../../components/ui/button";
import { ModraProposalCommands, ModraReview } from "./review";
import { AIImageAttachments } from "../../workspace/ai-image-attachments";
import { AIToolCalls } from "../../workspace/ai-tool-calls";
import type { ConversationMessage } from "../../workspace/ai-conversation-message";
import { CopyMessageText, ModraMessageContent } from "./message-content";
import { ObjectReferenceChips } from "./object-references";
import { ModraTaskPlan } from "./task-plan";

interface ModraTranscriptProps {
  buildFromPlan?: (message: ConversationMessage) => void;
  active: boolean;
  messages: readonly ConversationMessage[];
  isBusy: boolean;
  activeAssistantMessageId?: string;
  acceptProposal: (message: ConversationMessage) => void;
  rejectProposal: (id: string | number) => void;
}

export function ModraTranscript({
  buildFromPlan,
  active,
  messages,
  isBusy,
  activeAssistantMessageId,
  acceptProposal,
  rejectProposal,
}: ModraTranscriptProps) {
  const { t, i18n } = useTranslation("ai");
  const scroll = useTranscriptScroll(active, messages);
  const responding = isBusy && activeAssistantMessageId !== undefined;
  return (
    <div className="relative flex min-h-20 min-w-0 flex-1 flex-col">
      <div
        className="ai-transcript min-h-0 flex-1 overflow-auto px-px py-0.5 outline-offset-[-2px]"
        style={{ overflowAnchor: "none", scrollBehavior: "auto" }}
        ref={scroll.viewportRef}
        tabIndex={0}
        aria-label={t("messages")}
        aria-live="polite"
        onWheel={scroll.onWheel}
        onTouchMove={scroll.onTouchMove}
        onPointerDown={scroll.onPointerDown}
        onKeyDown={scroll.onKeyDown}
        onScrollCapture={scroll.onScrollCapture}
      >
        <div ref={scroll.contentRef} className="flex min-h-full flex-col items-stretch">
          {messages.length === 0 ? (
            <div className="ai-conversation-empty grid flex-1 content-center justify-items-center gap-2 text-center text-muted">
              <Bot size={20} />
              <p className="m-0 max-w-[180px] text-[13px]">{t("empty")}</p>
            </div>
          ) : (
            messages.map((message) => (
              <article className="ai-message w-full min-w-0 self-start px-1 py-2" key={message.id}>
                <div className="ai-message-header flex min-h-6 items-center gap-2 text-[12px] text-muted">
                  <span>{message.role === "user" ? t("you") : t("assistantRole")}</span>
                  {message.createdAt !== undefined && (
                    <time
                      dateTime={new Date(message.createdAt).toISOString()}
                      title={new Date(message.createdAt).toLocaleString(i18n.language)}
                      className="text-[11px] tabular-nums"
                    >
                      {new Date(message.createdAt).toLocaleTimeString(i18n.language, {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </time>
                  )}
                  <div className="ml-auto">{message.text && <CopyMessageText text={message.text} />}</div>
                </div>
                {message.images?.length ? <AIImageAttachments images={message.images} /> : null}
                {message.references?.length ? <ObjectReferenceChips references={message.references} /> : null}
                {message.role === "assistant" && message.parts ? (
                  <>
                    {message.parts.map((part, index) => (
                      <div key={index} data-message-part={part.type}>
                        {part.type === "text" ? (
                          <ModraMessageContent text={message.text.slice(part.start, part.end)} />
                        ) : part.type === "tool" ? (
                          <AIToolCalls calls={(message.toolCalls ?? []).filter((tool) => tool.id === part.id)} />
                        ) : part.type === "changes" ? (
                          <ModraProposalCommands proposals={(message.proposals ?? []).slice(part.start, part.end)} />
                        ) : message.plan ? (
                          <ModraTaskPlan
                            plan={message.plan}
                            disabled={isBusy}
                            onBuild={
                              message.taskMode === "plan" && buildFromPlan ? () => buildFromPlan(message) : undefined
                            }
                          />
                        ) : null}
                      </div>
                    ))}
                    {!message.parts.length && isBusy && message.id === activeAssistantMessageId && (
                      <LoaderCircle className="mt-1 size-4 animate-spin motion-reduce:animate-none" />
                    )}
                  </>
                ) : message.text ? (
                  message.role === "assistant" ? (
                    <ModraMessageContent text={message.text} />
                  ) : (
                    <p className="mt-1 mb-0 break-words whitespace-pre-wrap text-[13px] leading-6 text-foreground">
                      {message.text}
                    </p>
                  )
                ) : (
                  <p className="mt-1 mb-0 text-[13px] leading-6">
                    {isBusy && message.id === activeAssistantMessageId ? (
                      <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" />
                    ) : null}
                  </p>
                )}
                {!message.parts && message.toolCalls?.length ? <AIToolCalls calls={message.toolCalls} /> : null}
                {!message.parts && message.plan && (
                  <ModraTaskPlan
                    plan={message.plan}
                    disabled={isBusy}
                    onBuild={message.taskMode === "plan" && buildFromPlan ? () => buildFromPlan(message) : undefined}
                  />
                )}
                <ModraReview
                  message={message}
                  showCommands={!message.parts}
                  isBusy={isBusy}
                  acceptProposal={acceptProposal}
                  rejectProposal={rejectProposal}
                />
              </article>
            ))
          )}
        </div>
      </div>
      {scroll.showReturn && (
        <div className="pointer-events-none absolute left-1/2 bottom-0.5 z-10 -translate-x-1/2">
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="group pointer-events-auto size-8 rounded-full bg-sheet shadow-sm"
            aria-label={t("returnToBottom")}
            title={t("returnToBottom")}
            onPointerDown={(event) => event.preventDefault()}
            onClick={(event) => scroll.returnToBottom(document.activeElement === event.currentTarget)}
          >
            {responding && (
              <LoaderCircle
                data-return-loading
                className="size-3.5 animate-spin group-hover:hidden group-focus-visible:hidden motion-reduce:animate-none"
              />
            )}
            <ArrowDown
              className={`size-3.5 ${responding ? "hidden group-hover:block group-focus-visible:block" : ""}`}
            />
          </Button>
        </div>
      )}
    </div>
  );
}