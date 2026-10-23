import { Copy, Ellipsis, FolderOpen, Pencil, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { LocalProjectSummary } from "@open-3d/projects";
import { Button } from "../components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";

export function LocalProjectRow({
  project,
  current,
  disabled,
  onOpen,
  onRename,
  onDuplicate,
  onDelete,
}: {
  project: LocalProjectSummary;
  current: boolean;
  disabled: boolean;
  onOpen: () => void;
  onRename: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const { t, i18n } = useTranslation("projects");
  return (
    <div
      className={`local-project-row flex min-w-0 items-center justify-between gap-3 rounded-lg px-2 py-3 ${current ? "bg-selection" : "hover:bg-soft"}`}
      aria-current={current ? "true" : undefined}
      data-project-id={project.id}
    >
      <div className="grid min-w-0 gap-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <strong className="min-w-0 truncate text-sm font-medium" title={project.name}>
            {project.name}
          </strong>
        </div>
        <small className="text-[13px] text-muted">{new Date(project.updatedAt).toLocaleString(i18n.language)}</small>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button variant="outline" disabled={disabled} onClick={onOpen}>
          <FolderOpen className="size-4" />
          {t("open")}
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger
            disabled={disabled}
            render={<Button variant="ghost" size="icon" />}
            aria-label={t("manageNamed", { name: project.name })}
            title={t("manageNamed", { name: project.name })}
          >
            <Ellipsis className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem onClick={onRename}>
              <Pencil />
              {t("rename")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onDuplicate}>
              <Copy />
              {t("duplicate")}
            </DropdownMenuItem>
            <DropdownMenuItem
              className="text-destructive data-highlighted:bg-negative-soft data-highlighted:text-destructive"
              onClick={onDelete}
            >
              <Trash2 />
              {t("delete")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}