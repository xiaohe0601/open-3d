import { useTranslation } from "react-i18next";
import { Check, CircleAlert, LoaderCircle, Wrench, X } from "lucide-react";
import type { ConversationToolCall } from "./ai-conversation-message";

export function AIToolCalls({ calls }: { calls: ConversationToolCall[] }) {
  const { t } = useTranslation("ai");
  return (
    <section className="mt-2 min-w-0 border-t border-border pt-1" aria-label={t("toolCalls")}>
      <ol className="m-0 grid min-w-0 list-none gap-1 p-0">
        {calls.map((call) => {
          const busy = call.status === "preparing" || call.status === "running";
          const Icon = busy
            ? LoaderCircle
            : call.status === "completed"
              ? Check
              : call.status === "failed"
                ? CircleAlert
                : X;
          return (
            <li key={call.id} data-ai-tool-call data-tool-status={call.status} className="min-w-0">
              <details className="min-w-0 text-[13px]">
                <summary className="cursor-pointer rounded py-1 text-muted focus-visible:outline-2 focus-visible:outline-ring">
                  <span className="ml-1 inline-flex max-w-[90%] items-center gap-1.5 align-middle">
                    <Icon
                      aria-hidden
                      className={`size-3.5 shrink-0 ${busy ? "animate-spin motion-reduce:animate-none" : ""}`}
                    />
                    <span className="flex min-w-0 items-center gap-2">
                      <code className="truncate text-foreground" title={call.name}>
                        {call.name}
                      </code>
                      <span className="shrink-0 text-xs">{t(`toolStatus.${call.status}`)}</span>
                    </span>
                  </span>
                </summary>
                <div className="grid gap-1.5 border-l border-border py-1 pl-3">
                  <div>
                    <span className="text-muted">{t("toolInput")}</span>
                    <pre className="m-0 max-h-40 overflow-auto whitespace-pre-wrap break-all text-foreground">
                      {JSON.stringify(call.input ?? {}, null, 2)}
                    </pre>
                  </div>
                  {call.output !== undefined && (
                    <div>
                      <span className="text-muted">{t("toolOutput")}</span>
                      <pre className="m-0 max-h-40 overflow-auto whitespace-pre-wrap break-all text-foreground">
                        {JSON.stringify(call.output, null, 2)}
                      </pre>
                    </div>
                  )}
                  {call.status === "failed" && <span className="text-destructive">{t("toolFailed")}</span>}
                  <span className="flex items-center gap-1 text-muted">
                    <Wrench className="size-3 shrink-0" aria-hidden />
                    {t("toolExecutionNote")}
                  </span>
                </div>
              </details>
            </li>
          );
        })}
      </ol>
    </section>
  );
}