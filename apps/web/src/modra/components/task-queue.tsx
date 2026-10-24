import { useTranslation } from "react-i18next";
import type { ModraSessionState } from "@open-3d/ai/runtime";
import { X } from "lucide-react";
import { Button } from "../../components/ui/button";

export function ModraTaskQueue({
  queue,
  disabled,
  canResume,
  onRemove,
  onResume,
  onPause,
}: {
  queue: ModraSessionState["queue"];
  disabled: boolean;
  canResume: boolean;
  onRemove: (id: string) => void;
  onResume: () => void;
  onPause: () => void;
}) {
  const { t } = useTranslation("ai");
  if (!queue?.entries.length) return null;
  return (
    <section className="grid shrink-0 gap-1 rounded-lg bg-soft/60 px-2 py-1 text-[13px]" aria-label={t("taskQueue")}>
      <div className="flex flex-wrap items-center justify-between gap-1">
        <span>{t(queue.paused ? "queuePaused" : "queueWaiting", { count: queue.entries.length })}</span>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={disabled || (queue.paused && !canResume)}
          onClick={queue.paused ? onResume : onPause}
        >
          {t(queue.paused ? "resumeQueue" : "pauseQueue")}
        </Button>
      </div>
      <ol className="m-0 grid max-h-24 gap-1 overflow-auto pl-4">
        {queue.entries.map((entry) => (
          <li key={entry.id} data-queued-task={entry.id}>
            <div className="flex min-w-0 items-center gap-1">
              <span className="min-w-0 flex-1 truncate" title={entry.text}>
                {entry.text || t("imagePrompt")}
                {entry.assets.length ? ` · ${t("queueImages", { count: entry.assets.length })}` : ""}
              </span>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                disabled={disabled}
                aria-label={t("removeQueued", { text: entry.text || t("imagePrompt") })}
                onClick={() => onRemove(entry.id)}
              >
                <X />
              </Button>
            </div>
            <details className="min-w-0">
              <summary className="cursor-pointer text-muted">{t("inspectQueued")}</summary>
              <p className="m-0 whitespace-pre-wrap break-words">{entry.text}</p>
              <p className="m-0">
                {t(entry.mode === "plan" ? "planMode" : "buildMode")} ·{" "}
                {t(entry.approval === "auto" ? "autoApproval" : "requestApproval")}
              </p>
              {entry.references.map((reference) => (
                <p key={reference.id} className="m-0 break-words">
                  @{reference.name}
                </p>
              ))}
              {entry.assets.map((asset) => (
                <p key={asset.assetId} className="m-0 break-words">
                  {asset.name}
                </p>
              ))}
            </details>
          </li>
        ))}
      </ol>
      {queue.error && (
        <span className="text-destructive" role="alert">
          {t(queue.error === "context-reference" ? "contextReferenceError" : "queueDispatchError")}
        </span>
      )}
    </section>
  );
}