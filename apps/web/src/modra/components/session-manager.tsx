import { displaySessionTitle, limitSessionTitle } from "../storage/session-title";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { History, Pencil, SquarePen, Trash2, X } from "lucide-react";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import type { useModraController } from "../controller/use-modra-controller";
import { ModraStorageError } from "../storage/indexeddb-repository";
import type { ConversationImage } from "../../workspace/ai-conversation-message";

type Controller = ReturnType<typeof useModraController>;
type Entry = Awaited<ReturnType<Controller["listSessions"]>>[number];
type Action = { kind: "open" | "delete"; id: string } | { kind: "create" };

export function ModraSessionManager({
  controller,
  draft,
  needsStop,
}: {
  controller: Controller;
  draft: {
    text: string;
    images: readonly ConversationImage[];
    references?: readonly import("@open-3d/ai/runtime").ObjectReference[];
  };
  needsStop: boolean;
}) {
  const { t } = useTranslation("ai");
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState<"sessionActionError" | "sessionOwnedError" | null>(null);
  const [confirmation, setConfirmation] = useState<Action | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const { runtime, state } = controller;
  const name = (record: { title: string; titleSource?: "auto" | "manual" }) =>
    displaySessionTitle(record, t("sessionUntitled"));
  useEffect(() => {
    setOpen(false);
    setConfirmation(null);
    setEditing(null);
  }, [runtime]);

  function report(error: unknown) {
    setError(error instanceof ModraStorageError && error.code === "owned" ? "sessionOwnedError" : "sessionActionError");
  }
  async function refresh() {
    try {
      setEntries(await controller.listSessions());
    } catch (error) {
      report(error);
    }
  }
  async function perform(action: Action) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      if (action.kind === "create") await controller.createSession(draft);
      else if (action.kind === "open") await controller.openSession(action.id, draft);
      else await controller.deleteSession(action.id, draft);
      setConfirmation(null);
      if (action.kind !== "delete" || action.id === state.id) setOpen(false);
      else await refresh();
    } catch (error) {
      report(error);
      // A failed cleanup stays sealed and is shown as a retryable row.
      await refresh();
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  function request(action: Action) {
    if (action.kind === "open" && action.id === state.id) {
      setOpen(false);
      return;
    }
    if (action.kind === "delete" || needsStop) setConfirmation(action);
    else void perform(action);
  }
  return (
    <>
      <Button
        ref={triggerRef}
        type="button"
        variant="ghost"
        size="sm"
        className="h-9 min-w-0 shrink gap-1.5 px-1.5"
        disabled={!controller.ready}
        aria-label={t("sessions")}
        title={controller.sessionTitle ?? t("sessionUntitled")}
        onClick={() => {
          setError(null);
          setOpen(true);
          void refresh();
        }}
      >
        <History className="shrink-0" />
        <span className="truncate">{controller.sessionTitle ?? t("sessionUntitled")}</span>
      </Button>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!busy) setOpen(value);
        }}
      >
        <DialogContent
          finalFocus={triggerRef}
          className="flex h-[min(560px,calc(100dvh-32px))] min-h-0 flex-col overflow-hidden p-0"
        >
          <DialogHeader className="gap-2">
            <DialogTitle className="min-w-0 flex-1">{t("sessions")}</DialogTitle>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              disabled={busy}
              aria-label={t("sessionCreate")}
              title={t("sessionCreate")}
              onClick={() => request({ kind: "create" })}
            >
              <SquarePen />
            </Button>
            <DialogClose
              disabled={busy}
              render={<Button variant="ghost" size="icon" aria-label={t("closeSessions")} />}
            >
              <X />
            </DialogClose>
          </DialogHeader>
          <div className="flex min-h-0 flex-1 flex-col px-4 pb-5">
            <div
              data-testid="modra-session-list"
              className="grid min-h-0 min-w-0 flex-1 content-start gap-1 overflow-x-hidden overflow-y-auto"
            >
              {entries.map(({ record, sealed }) => (
                <div key={record.id} className="flex min-w-0 items-center gap-1 py-1">
                  {editing === record.id ? (
                    <form
                      className="flex min-w-0 flex-1 items-center gap-1"
                      onSubmit={(event) => {
                        event.preventDefault();
                        if (pending.current || !title.trim()) return;
                        pending.current = true;
                        setBusy(true);
                        setError(null);
                        void controller
                          .renameSession(record.id, title)
                          .then(async () => {
                            setEditing(null);
                            await refresh();
                          })
                          .catch(report)
                          .finally(() => {
                            pending.current = false;
                            setBusy(false);
                          });
                      }}
                    >
                      <Input
                        className="h-8 min-w-0 flex-1 focus-visible:ring-inset"
                        aria-label={t("sessionTitle")}
                        value={title}
                        onChange={(event) => setTitle(limitSessionTitle(event.target.value))}
                        disabled={busy}
                      />
                      <Button type="submit" className="h-8" size="sm" disabled={busy || !title.trim()}>
                        {t("sessionRenameSave")}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        className="h-8"
                        size="sm"
                        disabled={busy}
                        onClick={() => setEditing(null)}
                      >
                        {t("sessionCancel")}
                      </Button>
                    </form>
                  ) : (
                    <>
                      <Button
                        type="button"
                        variant="ghost"
                        className="min-w-0 flex-1 justify-start focus-visible:ring-inset"
                        disabled={busy || sealed}
                        aria-current={record.id === state.id ? "true" : undefined}
                        title={name(record)}
                        onClick={() => request({ kind: "open", id: record.id })}
                      >
                        <span className="truncate">{name(record)}</span>
                      </Button>
                      {!sealed && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          disabled={busy}
                          aria-label={t("sessionRenameNamed", { name: name(record) })}
                          onClick={() => {
                            setEditing(record.id);
                            setTitle(name(record));
                          }}
                        >
                          <Pencil />
                        </Button>
                      )}
                      <Button
                        type="button"
                        variant="ghost"
                        size={sealed ? "sm" : "icon"}
                        className="text-destructive hover:bg-negative-soft"
                        disabled={busy}
                        aria-label={t(sealed ? "sessionRetryDeleteNamed" : "sessionDeleteNamed", {
                          name: name(record),
                        })}
                        onClick={() => request({ kind: "delete", id: record.id })}
                      >
                        <Trash2 />
                        {sealed ? t("sessionRetryDelete") : null}
                      </Button>
                    </>
                  )}
                </div>
              ))}
              {!entries.length && <p className="text-[13px] text-muted">{t("sessionsEmpty")}</p>}
            </div>
            {error && (
              <p role="alert" className="text-[13px] text-destructive">
                {t(error)}
              </p>
            )}
          </div>
          <Dialog
            open={confirmation !== null}
            onOpenChange={(value) => {
              if (!value && !busy) setConfirmation(null);
            }}
          >
            <DialogContent className="z-[1003]" backdropClassName="z-[1002]">
              <DialogTitle>
                {t(confirmation?.kind === "delete" ? "sessionDeleteTitle" : "sessionSwitchTitle")}
              </DialogTitle>
              <DialogDescription className="my-3 text-sm text-muted">
                {t(confirmation?.kind === "delete" ? "sessionDeleteNotice" : "sessionSwitchNotice")}
              </DialogDescription>
              {error && (
                <p role="alert" className="text-[13px] text-destructive">
                  {t(error)}
                </p>
              )}
              <div className="flex flex-wrap justify-end gap-2">
                <Button variant="ghost" disabled={busy} onClick={() => setConfirmation(null)}>
                  {t("sessionCancel")}
                </Button>
                <Button
                  variant={confirmation?.kind === "delete" ? "destructive" : "default"}
                  disabled={busy}
                  onClick={() => confirmation && void perform(confirmation)}
                >
                  {t(confirmation?.kind === "delete" ? "sessionDeleteConfirm" : "sessionSwitchConfirm")}
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </DialogContent>
      </Dialog>
    </>
  );
}