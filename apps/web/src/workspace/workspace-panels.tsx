import { Copy, Eye, EyeOff, FolderOpen, Redo2, Save, Trash2, Undo2 } from "lucide-react";
import type { ReactNode } from "react";
import type { ModelingObject } from "@open-3d/model-core";
import { ObjectIcon } from "./object-icon";
import { ProjectNameEditor } from "./project-name-editor";
import { AddObjectMenu } from "./add-object-menu";
import type { Primitive } from "./modeling";
import { WorkspacePreferenceControls } from "./workspace-preference-controls";
import { Button } from "../components/ui/button";
import { useTranslation } from "react-i18next";

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
      <WorkspacePreferenceControls />
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
      className="left-panel flex min-h-0 flex-col bg-ground p-[10px] max-[1120px]:p-1.5"
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
      <div className="object-list grid gap-0.5">
        {items.map((item) => (
          <div
            className={`object-row flex h-[33px] w-full items-center gap-1 rounded-[5px] py-0 pr-[5px] pl-2 ${selectedObjectIds.includes(item.id) ? "selected bg-selection text-foreground" : "hover:bg-soft"}`}
            key={item.id}
            data-testid="object-row"
          >
            <Button
              variant="ghost"
              className="flex h-full min-w-0 flex-1 items-center gap-2 border-0 bg-transparent pr-0 pl-[3px] text-left text-[13px] hover:bg-transparent active:bg-transparent"
              onClick={(event) => onSelectObject(item.id, item.name, event.shiftKey)}
              aria-current={item.id === activeObjectId ? "true" : undefined}
            >
              <span className="object-glyph w-[15px] text-center text-sm text-muted">
                <ObjectIcon mesh={item.mesh} className="size-3.5" />
              </span>
              <span className="object-label min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap">
                {item.name}
              </span>
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              className={`h-[25px] w-[25px] shrink-0 rounded bg-transparent text-[13px] text-muted opacity-[0.85] hover:bg-soft hover:opacity-100 ${item.visible ? "" : "text-warning opacity-75"}`}
              onClick={() => onToggleVisibility(item)}
              aria-label={t(item.visible ? "hideNamedObject" : "showNamedObject", { name: item.name })}
              title={t(item.visible ? "hideObject" : "showObject")}
            >
              {item.visible ? <Eye size={14} /> : <EyeOff size={14} />}
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              className="grid h-[25px] w-[23px] shrink-0 place-items-center rounded bg-transparent text-muted hover:bg-soft"
              onClick={() => onDuplicateObject(item)}
              aria-label={t("duplicateObject", { name: item.name })}
              title={t("duplicateObject", { name: item.name })}
            >
              <Copy size={13} />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              className="grid h-[25px] w-[23px] shrink-0 place-items-center rounded bg-transparent text-destructive hover:bg-negative-soft"
              onClick={() => onDeleteObject(item)}
              aria-label={t("deleteObject", { name: item.name })}
              title={t("deleteObject", { name: item.name })}
            >
              <Trash2 size={13} />
            </Button>
          </div>
        ))}
      </div>
      {!items.length && (
        <div className="empty-hierarchy px-2 py-[13px] text-[13px] text-muted">{t("emptyHierarchy")}</div>
      )}
    </aside>
  );
}