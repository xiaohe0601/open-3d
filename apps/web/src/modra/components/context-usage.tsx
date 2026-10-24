import { Popover } from "@base-ui/react/popover";
import { LoaderCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useCallback, useSyncExternalStore } from "react";
import {
  buildSemanticHistory,
  contextWindowUsage,
  currentSceneContext,
  type ModraSessionState,
  type TaskMode,
} from "@open-3d/ai/runtime";
import type { WorkspaceModelingHost } from "../controller/workspace-host";
import { Button } from "../../components/ui/button";

export function ModraContextUsage({
  state,
  protocol,
  configured,
  host,
  mode,
  draft,
  imageCount,
  referenceCount,
  busy,
}: {
  state: ModraSessionState;
  protocol: string;
  configured?: number;
  host: WorkspaceModelingHost;
  mode: TaskMode;
  draft: string;
  imageCount: number;
  referenceCount: number;
  busy: boolean;
}) {
  const { t, i18n } = useTranslation("ai");
  const subscribe = useCallback(
    (notify: () => void) =>
      host.subscribe((event) => {
        if (event.type === "changed") notify();
      }),
    [host],
  );
  const version = useCallback(() => JSON.stringify(host.snapshot().version), [host]);
  useSyncExternalStore(subscribe, version);
  const history = buildSemanticHistory(state, protocol);
  const scene = currentSceneContext({ scene: host.snapshot(), mode });
  const usage = contextWindowUsage(
    history,
    configured,
    Math.ceil(new TextEncoder().encode(JSON.stringify(scene)).byteLength / 3),
    mode,
  );
  const input =
    usage.inputTokens +
    (busy ? 0 : Math.ceil(new TextEncoder().encode(draft).byteLength / 3) + imageCount * 4096 + referenceCount * 256);
  const percent = Math.round((input / usage.windowTokens) * 100);
  const compacting = busy && !!state.run?.compacting;
  const number = (value: number) => value.toLocaleString(i18n.language);
  return (
    <Popover.Root>
      <Popover.Trigger
        render={<Button type="button" variant="ghost" size="icon" className="text-muted" />}
        aria-label={t("contextWindow")}
        title={t("contextUsageLabel", { percent })}
      >
        {compacting ? (
          <LoaderCircle className="size-4 animate-spin" />
        ) : (
          <svg viewBox="0 0 20 20" className="size-4" aria-hidden="true">
            <circle cx="10" cy="10" r="7" fill="none" stroke="currentColor" strokeWidth="2" opacity="0.2" />
            <circle
              cx="10"
              cy="10"
              r="7"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              pathLength="100"
              strokeDasharray={`${Math.min(100, percent)} 100`}
              transform="rotate(-90 10 10)"
            />
          </svg>
        )}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="top" sideOffset={8} collisionPadding={16} className="z-[1200]">
          <Popover.Popup
            aria-label={t("contextWindow")}
            className="grid w-64 max-w-[calc(100vw-32px)] gap-2 rounded-lg border border-border bg-sheet p-3 text-[12px] text-foreground shadow-sm"
          >
            <h3 className="m-0 text-[13px] font-medium">{t("contextWindow")}</h3>
            <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-1 tabular-nums">
              <span>{t("contextUsageLabel", { percent })}</span>
              <span className="whitespace-nowrap">
                ~{number(input)} / {number(usage.windowTokens)}
              </span>
            </div>
            {compacting && <p className="m-0 text-muted">{t("contextCompacting")}</p>}
            {state.contextCheckpoint && (
              <span>{t("contextCompactions", { count: state.contextCheckpoint.compactions })}</span>
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}