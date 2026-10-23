import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { LocalProjectSummary } from "@open-3d/projects";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { projectNameSchema } from "../lib/ui-schemas";

export type ProjectAction = { type: "rename" | "delete"; project: LocalProjectSummary };

export function LocalProjectAction({
  action,
  busy,
  error,
  onCancel,
  onRenameProject,
  onDeleteProject,
}: {
  action: ProjectAction;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onRenameProject: (project: LocalProjectSummary, name: string) => Promise<boolean>;
  onDeleteProject: (project: LocalProjectSummary) => Promise<boolean>;
}) {
  const { t } = useTranslation(["projects", "common"]);
  const [draft, setDraft] = useState(action.project.name);
  const [invalid, setInvalid] = useState(false);
  const focusTarget = useRef<HTMLInputElement | null>(null);
  const cancelTarget = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (focusTarget.current) {
        focusTarget.current.focus();
        focusTarget.current.select();
      } else cancelTarget.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onCancel();
      }}
    >
      <DialogContent
        backdropClassName="z-[1002]"
        aria-describedby={undefined}
        className="z-[1003] w-[min(420px,calc(100vw-32px))]"
      >
        <DialogTitle className={action.type === "rename" ? "sr-only" : undefined}>
          {t(action.type === "rename" ? "renameProject" : "deleteTitle")}
        </DialogTitle>
        {action.type === "delete" && (
          <p className="mt-4 text-sm leading-6 text-muted">{t("deleteDescription", { name: action.project.name })}</p>
        )}
        {error && (
          <p className="mt-3 text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
        {action.type === "rename" && (
          <form
            className="grid gap-3"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              if (busy) return;
              const parsed = projectNameSchema.safeParse(draft);
              if (!parsed.success) {
                setInvalid(true);
                return;
              }
              void onRenameProject(action.project, parsed.data).then((success) => {
                if (success) onCancel();
              });
            }}
          >
            <label htmlFor="saved-project-name" className="text-sm font-medium">
              {t("projectName")}
            </label>
            <Input
              id="saved-project-name"
              ref={focusTarget}
              aria-label={t("projectName")}
              value={draft}
              disabled={busy}
              aria-invalid={invalid}
              aria-describedby={invalid ? "saved-project-name-error" : undefined}
              onChange={(event) => {
                setDraft(event.currentTarget.value);
                setInvalid(false);
              }}
            />
            {invalid && (
              <p id="saved-project-name-error" className="m-0 text-sm text-destructive" role="alert">
                {t("nameRequired")}
              </p>
            )}
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="outline" type="button" disabled={busy} onClick={() => onCancel()}>
                {t("cancel")}
              </Button>
              <Button type="submit" disabled={busy}>
                {t("common:save")}
              </Button>
            </div>
          </form>
        )}
        {action.type === "delete" && (
          <section className="mt-4 grid gap-3">
            <div className="flex flex-wrap justify-end gap-2">
              <Button ref={cancelTarget} variant="outline" disabled={busy} onClick={() => onCancel()}>
                {t("cancel")}
              </Button>
              <Button
                variant="destructive"
                disabled={busy}
                onClick={() => {
                  void onDeleteProject(action.project).then((success) => {
                    if (success) onCancel();
                  });
                }}
              >
                {t("delete")}
              </Button>
            </div>
          </section>
        )}
      </DialogContent>
    </Dialog>
  );
}