import { useTranslation } from "react-i18next";
import { Check, X } from "lucide-react";
import { Button } from "../../components/ui/button";
import { commandLabel } from "../../workspace/localization";
import type { ConversationMessage } from "../../workspace/ai-conversation-message";

export function ModraReview({
  message,
  showCommands = true,
  isBusy,
  acceptProposal,
  rejectProposal,
}: {
  message: ConversationMessage;
  showCommands?: boolean;
  isBusy: boolean;
  acceptProposal: (message: ConversationMessage) => void;
  rejectProposal: (id: string | number) => void;
}) {
  const { t } = useTranslation("ai");
  if (!message.proposals?.length) return null;
  // Streaming commands already appear inline; append the batch decision only when ready.
  if (message.parts && message.proposalStatus === "pending" && !message.proposalReady) return null;
  return (
    <section className="mt-2 grid gap-2 border-t border-border pt-2" aria-label={t("proposal")}>
      <strong className="text-[13px] text-foreground">{t("preview", { count: message.proposals.length })}</strong>
      <span className="text-[13px] text-muted">{t("wholeBatchReview")}</span>
      {message.affectedObjects?.length ? (
        <details className="min-w-0 text-[13px]">
          <summary className="cursor-pointer">
            {t("affectedObjects", { count: message.affectedObjects.length })}
          </summary>
          <ul className="m-0 mt-1 max-h-36 overflow-auto pl-4">
            {message.affectedObjects.map((object) => (
              <li key={object.id} data-affected-object={object.id}>
                <span className="break-words" title={`${object.previousName ?? object.name} (${object.id})`}>
                  {object.name}
                </span>
                <span className="ml-2 text-muted">{t(`objectChange.${object.kind}`)}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : (
        <span className="text-[13px] text-muted">{t("nonObjectChanges")}</span>
      )}
      {showCommands && <ModraProposalCommands proposals={message.proposals} bounded />}
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
      {message.proposalStatus === "accepted" && message.applicationEffect && (
        <span className="text-[13px] text-muted" data-application-effect={message.applicationEffect}>
          {t(`applicationEffect.${message.applicationEffect}`)}
        </span>
      )}
      {message.proposalStatus === "stale" && <span className="text-[13px] text-muted">{t("staleProposal")}</span>}
      {message.proposalStatus === "rejected" && (
        <span className="text-[13px] text-muted" role="status">
          {t("rejected")}
        </span>
      )}
    </section>
  );
}

export function ModraProposalCommands({
  proposals,
  bounded = false,
}: {
  proposals: NonNullable<ConversationMessage["proposals"]>;
  bounded?: boolean;
}) {
  const { t } = useTranslation("ai");
  return (
    <ol
      aria-label={t("proposal")}
      data-ai-proposals
      className={`m-0 mt-2 grid gap-1 pl-5 text-[13px] text-muted ${bounded ? "max-h-36 overflow-auto" : ""}`}
    >
      {proposals.map((proposal, index) => (
        <li key={index}>
          <span className="font-semibold text-foreground">{commandLabel(proposal.commandId)}</span>
          <code className="mt-0.5 block break-all">{JSON.stringify(proposal.arguments)}</code>
        </li>
      ))}
    </ol>
  );
}