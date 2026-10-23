import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import type { LocalProjectSummary } from "@open-3d/projects";
import { Button } from "../components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { LocalProjectRow } from "./local-project-row";
import { LocalProjectAction, type ProjectAction } from "./local-project-action";

interface LocalProjectsDialogProps {
  open: boolean;
  projects: LocalProjectSummary[];
  currentProjectId?: string;
  loading: boolean;
  busy: boolean;
  error: string | null;
  onOpenChange: (open: boolean) => void;
  onOpenProject: (project: LocalProjectSummary) => void;
  onRenameProject: (project: LocalProjectSummary, name: string) => Promise<boolean>;
  onDuplicateProject: (project: LocalProjectSummary) => void;
  onDeleteProject: (project: LocalProjectSummary) => Promise<boolean>;
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
  onRenameProject,
  onDuplicateProject,
  onDeleteProject,
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
                  disabled={busy || loading}
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