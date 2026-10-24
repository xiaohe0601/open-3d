import { Copy, Ellipsis, Eye, EyeOff, FolderOpen, Redo2, Save, Trash2, Undo2 } from "lucide-react";
import type { ReactNode } from "react";
import type { ModelingObject } from "@open-3d/model-core";
import { ObjectIcon } from "./object-icon";
import { ProjectNameEditor } from "./project-name-editor";
import { AddObjectMenu } from "./add-object-menu";
import type { Primitive } from "./modeling";
import { WorkspacePreferenceControls } from "./workspace-preference-controls";
import { Button, buttonVariants } from "../components/ui/button";
import { useTranslation } from "react-i18next";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";

export interface SceneHierarchyItem {
  id: string;
  name: string;
  visible: boolean;
  mesh: ModelingObject["mesh"];
}

interface WorkspaceHeaderProps {
  documentName: string;
  canUndo: boolean;
  canRedo: boolean;
  isDirty: boolean;
  isSaving: boolean;
  saveDisabled: boolean;
  hasLocalSave: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onSave: () => void;
  onOpenProjects: () => void;
  onRenameProject: (name: string) => void;
  fileActions: ReactNode;
}

export function WorkspaceHeader({
  documentName,
  canUndo,
  canRedo,
  isDirty,
  isSaving,
  saveDisabled,
  hasLocalSave,
  onUndo,
  onRedo,
  onSave,
  onOpenProjects,
  onRenameProject,
  fileActions,
}: WorkspaceHeaderProps) {
  const { t } = useTranslation("workspace");
  const { t: tc } = useTranslation("common");
  return (
    <header
      className="topbar flex min-h-14 shrink-0 flex-wrap items-center gap-2 bg-ground px-4 py-2 max-[600px]:px-2"
      data-testid="topbar"
    >
      <div className="project-identity flex min-w-0 flex-1 items-center gap-2">
        <div className="brand inline-flex shrink-0 items-center gap-[9px] whitespace-nowrap text-sm font-semibold text-foreground no-underline">
          <span className="brand-mark grid size-[25px] place-items-center rounded-[7px_7px_7px_2px] bg-accent text-[13px] font-semibold text-accent-foreground">
            O3
          </span>
          <h1 className="m-0 text-sm font-semibold">Open 3D</h1>
        </div>
        <ProjectNameEditor name={documentName} dirty={isDirty} onRename={onRenameProject} />
        <span className="save-state text-[13px] text-muted max-[1000px]:hidden">
          {isSaving ? t("saving") : isDirty ? t("unsavedChanges") : hasLocalSave ? t("savedLocally") : t("notSaved")}
        </span>
      </div>
      <div className="topbar-actions flex min-w-0 shrink-0 items-center gap-4 max-[1000px]:order-3 max-[1000px]:basis-full max-[600px]:justify-between max-[600px]:gap-3">
        <div role="group" aria-label={t("projectActions")} className="project-actions flex items-center gap-1">
          <Button
            className="h-8 rounded-md px-2.5 text-[13px] font-medium max-[600px]:w-8"
            variant="ghost"
            onClick={onOpenProjects}
            aria-label={t("openProjects")}
          >
            <FolderOpen size={15} /> <span className="max-[600px]:hidden">{t("projectLabel")}</span>
          </Button>
          {fileActions}
          <Button
            className="h-8 rounded-md px-2.5 text-[13px] font-medium max-[600px]:w-8"
            variant="ghost"
            onClick={onSave}
            disabled={isSaving || saveDisabled}
            aria-label={tc("save")}
            title={tc("save")}
          >
            <Save size={15} /> <span className="max-[600px]:hidden">{tc("save")}</span>
          </Button>
        </div>
        <div role="group" aria-label={t("editActions")} className="edit-actions flex items-center gap-1">
          <Button
            className="size-8 rounded-md text-muted hover:bg-soft max-[600px]:w-8"
            variant="ghost"
            size="icon-sm"
            onClick={onUndo}
            disabled={!canUndo}
            aria-label={t("undo")}
            title={t("undo")}
          >
            <Undo2 />
          </Button>
          <Button
            className="size-8 rounded-md text-muted hover:bg-soft max-[600px]:w-8"
            variant="ghost"
            size="icon-sm"
            onClick={onRedo}
            disabled={!canRedo}
            aria-label={t("redo")}
            title={t("redo")}
          >
            <Redo2 />
          </Button>
        </div>
      </div>
      <div className="topbar-links flex shrink-0 items-center gap-1">
        <WorkspacePreferenceControls />
        <a
          className={buttonVariants({ variant: "ghost", size: "icon" })}
          data-slot="button"
          href="https://github.com/xiaohe0601/open-3d"
          target="_blank"
          rel="noopener noreferrer"
          aria-label={t("githubRepository")}
          title={t("githubRepository")}
        >
          <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M12 .297C5.37.297 0 5.67 0 12.297c0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.043-1.61-4.043-1.61-.546-1.387-1.333-1.756-1.333-1.756-1.09-.745.083-.729.083-.729 1.205.084 1.838 1.237 1.838 1.237 1.07 1.835 2.807 1.305 3.492.998.108-.776.418-1.305.762-1.605-2.665-.3-5.466-1.334-5.466-5.93 0-1.31.47-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23a11.5 11.5 0 0 1 3-.404c1.02.005 2.045.138 3 .404 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
          </svg>
        </a>
      </div>
    </header>
  );
}

interface SceneHierarchyPanelProps {
  items: SceneHierarchyItem[];
  activeObjectId: string | null;
  selectedObjectIds: string[];
  onSelectObject: (id: string, name: string, extendSelection: boolean) => void;
  onToggleVisibility: (item: SceneHierarchyItem) => void;
  onDuplicateObject: (item: SceneHierarchyItem) => void;
  onDeleteObject: (item: SceneHierarchyItem) => void;
  onAddPrimitive: (primitive: Primitive) => void;
}

export function SceneHierarchyPanel({
  items,
  activeObjectId,
  selectedObjectIds,
  onSelectObject,
  onToggleVisibility,
  onDuplicateObject,
  onDeleteObject,
  onAddPrimitive,
}: SceneHierarchyPanelProps) {
  const { t } = useTranslation("workspace");
  return (
    <aside
      className="left-panel flex min-h-0 min-w-0 flex-col bg-ground p-[10px] max-[1120px]:p-1.5"
      id="scene-panel"
      data-testid="left-panel"
      aria-labelledby="objects-heading"
    >
      <div className="panel-heading flex h-[38px] shrink-0 items-center justify-between gap-2 pl-2">
        <div className="flex min-w-0 items-baseline gap-2">
          <h2 id="objects-heading" className="m-0 text-[15px] font-semibold leading-[19px]">
            {t("objects")}
          </h2>
          <span className="subtle text-[13px] text-muted">{t("objectCount", { count: items.length })}</span>
        </div>
        <AddObjectMenu onAddPrimitive={onAddPrimitive} />
      </div>
      <div className="object-list grid min-h-0 min-w-0 w-full grid-cols-1 content-start gap-0.5">
        {items.map((item) => (
          <div
            className={`object-row flex h-[33px] min-w-0 w-full items-center gap-1 rounded-[5px] py-0 pr-[5px] pl-2 ${selectedObjectIds.includes(item.id) ? "selected bg-selection text-foreground" : "hover:bg-soft"}`}
            key={item.id}
            data-testid="object-row"
          >
            <Button
              variant="ghost"
              className="flex h-full min-w-0 flex-1 shrink items-center gap-2 border-0 bg-transparent pr-0 pl-[3px] text-left text-[13px] hover:bg-transparent active:bg-transparent"
              onClick={(event) => onSelectObject(item.id, item.name, event.shiftKey)}
              aria-current={item.id === activeObjectId ? "true" : undefined}
              title={item.name}
            >
              <span className="object-glyph w-[15px] shrink-0 text-center text-sm text-muted">
                {item.visible ? (
                  <ObjectIcon mesh={item.mesh} className="size-3.5" />
                ) : (
                  <EyeOff className="size-3.5 text-warning" />
                )}
              </span>
              <span className="object-label min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                {item.name}
              </span>
            </Button>
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger
                render={<Button variant="ghost" size="icon-sm" className="size-[25px] text-muted" />}
                aria-label={t("objectActions", { name: item.name })}
                title={t("objectActions", { name: item.name })}
              >
                <Ellipsis className="size-3.5" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-0 w-max max-w-[calc(100vw-24px)]">
                <DropdownMenuItem
                  onClick={() => onToggleVisibility(item)}
                  aria-label={t(item.visible ? "hideNamedObject" : "showNamedObject", { name: item.name })}
                >
                  {item.visible ? <Eye /> : <EyeOff />}
                  {t(item.visible ? "hideObject" : "showObject")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => onDuplicateObject(item)}
                  aria-label={t("duplicateObject", { name: item.name })}
                >
                  <Copy />
                  {t("objectDuplicate")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="text-destructive data-highlighted:bg-negative-soft data-highlighted:text-destructive"
                  onClick={() => onDeleteObject(item)}
                  aria-label={t("deleteObject", { name: item.name })}
                >
                  <Trash2 />
                  {t("objectDelete")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ))}
      </div>
      {!items.length && (
        <div className="empty-hierarchy px-2 py-[13px] text-[13px] text-muted">{t("emptyHierarchy")}</div>
      )}
    </aside>
  );
}