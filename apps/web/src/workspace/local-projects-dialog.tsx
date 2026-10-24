import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { FilePlus2, X } from "lucide-react";
import type { LocalProjectSummary } from "@open-3d/projects";
import { Button } from "../components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { LocalProjectRow } from "./local-project-row";
import { LocalProjectAction, type ProjectAction } from "./local-project-action";
import type { ProjectDeletion } from "../modra/storage/project-deletion";

interface LocalProjectsDialogProps {
  open: boolean;
  projects: LocalProjectSummary[];
  currentProjectId?: string;
  loading: boolean;
  busy: boolean;
  error: string | null;
  onOpenChange: (open: boolean) => void;
  onOpenProject: (project: LocalProjectSummary) => void;
  onNewProject: () => void;
  onRenameProject: (project: LocalProjectSummary, name: string) => Promise<boolean>;
  onDuplicateProject: (project: LocalProjectSummary) => void;
  onDeleteProject: (project: LocalProjectSummary) => Promise<boolean>;
  deletions?: ProjectDeletion[];
  onRetryDeletion?: (projectId: string) => void;
  onCancelDeletion?: (projectId: string) => void;
}

export function LocalProjectsDialog({
  open,
  projects,
  currentProjectId,
  loading,
  busy,
  error,
  onOpenChange,
  onOpenProject,
  onNewProject,
  onRenameProject,
  onDuplicateProject,
  onDeleteProject,
  deletions = [],
  onRetryDeletion,
  onCancelDeletion,
}: LocalProjectsDialogProps) {
  const { t, i18n } = useTranslation("projects");
  const [search, setSearch] = useState("");
  const [action, setAction] = useState<ProjectAction | null>(null);
  const previousAction = useRef<ProjectAction | null>(null);
  const content = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = previousAction.current;
    previousAction.current = action;
    if (!open || action || !previous) return;
    const frame = requestAnimationFrame(() => {
      const trigger = content.current?.querySelector<HTMLElement>(
        `[data-project-id="${CSS.escape(previous.project.id)}"] [aria-haspopup="menu"]`,
      );
      (trigger ?? content.current?.parentElement?.querySelector<HTMLInputElement>("input"))?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [action, open]);
  useEffect(() => {
    if (!open) {
      setSearch("");
      setAction(null);
    }
  }, [open]);
  const filtered = projects.filter((project) =>
    project.name.toLocaleLowerCase(i18n.language).includes(search.trim().toLocaleLowerCase(i18n.language)),
  );
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
    >
      <DialogContent
        aria-describedby={undefined}
        className="flex h-[min(520px,calc(100dvh-32px))] w-[min(560px,calc(100vw-32px))] flex-col overflow-hidden p-0"
      >
        <DialogHeader>
          <div>
            <DialogTitle>{t("localProjects")}</DialogTitle>
          </div>
          <div className="flex shrink-0 items-start gap-1">
            <Button
              variant="ghost"
              size="icon"
              disabled={busy}
              aria-label={t("newProject")}
              title={t("newProject")}
              onClick={onNewProject}
            >
              <FilePlus2 className="size-4" />
            </Button>
            <DialogClose disabled={busy} render={<Button variant="ghost" size="icon" aria-label={t("close")} />}>
              <X className="size-4" />
            </DialogClose>
          </div>
        </DialogHeader>
        <div className="shrink-0 px-5 pt-1">
          <Input
            aria-label={t("search")}
            placeholder={t("search")}
            value={search}
            onChange={(event) => setSearch(event.currentTarget.value)}
          />
        </div>
        <div
          ref={content}
          className="grid min-h-0 flex-1 content-start gap-3 overflow-y-auto overscroll-contain px-5 pt-3 pb-5"
          aria-busy={busy || loading}
        >
          {error && !action && (
            <p className="m-0 text-sm text-destructive" role="alert">
              {error}
            </p>
          )}
          {deletions.map((operation) => (
            <section
              key={operation.projectId}
              className="grid min-w-0 gap-2 rounded-lg bg-soft p-3 text-sm"
              aria-label={t("pendingDeletion")}
              data-testid="pending-project-deletion"
            >
              <strong
                className="truncate font-medium"
                title={projects.find((project) => project.id === operation.projectId)?.name}
              >
                {projects.find((project) => project.id === operation.projectId)?.name ?? t("removedProject")}
              </strong>
              <p className="m-0 text-muted">
                {t(operation.phase === "removed" ? "cleanupPending" : "deletionPending")}
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  disabled={busy || loading}
                  onClick={() => onRetryDeletion?.(operation.projectId)}
                >
                  {t("retryDeletion")}
                </Button>
                {["sealed", "remove-failed"].includes(operation.phase) && (
                  <Button
                    variant="ghost"
                    disabled={busy || loading}
                    onClick={() => onCancelDeletion?.(operation.projectId)}
                  >
                    {t("cancelDeletion")}
                  </Button>
                )}
              </div>
            </section>
          ))}
          {loading && projects.length === 0 ? (
            <p className="m-0 text-sm text-muted" role="status">
              {t("loading")}
            </p>
          ) : filtered.length ? (
            <div className="grid gap-1" data-testid="local-project-list">
              {filtered.map((project) => (
                <LocalProjectRow
                  key={project.id}
                  project={project}
                  current={project.id === currentProjectId}
                  disabled={busy || loading || deletions.some((operation) => operation.projectId === project.id)}
                  onOpen={() => onOpenProject(project)}
                  onRename={() => setAction({ type: "rename", project })}
                  onDuplicate={() => onDuplicateProject(project)}
                  onDelete={() => setAction({ type: "delete", project })}
                />
              ))}
            </div>
          ) : (
            <p className="m-0 py-2 text-sm text-muted">{t(search.trim() ? "noResults" : "empty")}</p>
          )}
        </div>
        {loading && projects.length > 0 && (
          <span className="sr-only" role="status">
            {t("loading")}
          </span>
        )}
      </DialogContent>
      {action && (
        <LocalProjectAction
          key={`${action.type}:${action.project.id}`}
          action={action}
          busy={busy}
          error={error}
          onCancel={() => setAction(null)}
          onRenameProject={onRenameProject}
          onDeleteProject={onDeleteProject}
        />
      )}
    </Dialog>
  );
}