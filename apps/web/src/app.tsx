import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { MousePointer2 } from "lucide-react";
import { queryModelingDocument } from "@open-3d/model-core";
import type { ModelingDocument } from "@open-3d/model-core";
import { createLocalProjectStore, deserializeNativeProject, serializeNativeProject } from "@open-3d/projects";
import type { LocalProjectStore, LocalProjectSummary } from "@open-3d/projects";
import type { GltfFormat } from "@open-3d/projects/gltf";
import type { StandardView, ThreeViewport, ViewProjection, ViewportTransformHandler } from "@open-3d/viewport-three";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { finiteNumberSchema } from "./lib/ui-schemas";
import { useWorkspaceUiStore } from "./workspace-ui-store";

import { AIFloatingWorkspace } from "./workspace/ai-floating-workspace";
import { loadAIProviderSponsors } from "./workspace/ai-provider-sponsors-data";
import { LocalProjectsDialog } from "./workspace/local-projects-dialog";
import { ProjectTransferControls } from "./workspace/project-transfer-controls";
import { SceneHierarchyPanel, WorkspaceHeader } from "./workspace/workspace-panels";
import { UnsavedChangesDialog } from "./workspace/unsaved-changes-dialog";
import { PropertySection } from "./workspace/property-section";
import { ObjectIcon } from "./workspace/object-icon";
import { ViewShortcuts } from "./workspace/view-shortcuts";
import {
  createProcessor,
  emptyDocument,
  createTransformCommand,
  eulerToQuaternion,
  quaternionToEuler,
  selectedObject,
} from "./workspace/modeling";
import type {
  TransformOperation,
  TransformSession,
  TransformConfiguration,
  Vec3,
  Primitive,
} from "./workspace/modeling";
import "./style.css";
import i18n from "./i18n";
import {
  describeModelingError,
  describeProjectError,
  describeProjectFailure,
  type ProjectFailure,
  describeOmittedContent,
} from "./workspace/localization";

interface WorkspaceAppProps {
  projectStore?: LocalProjectStore;
}

export function WorkspaceApp({ projectStore: providedProjectStore }: WorkspaceAppProps = {}) {
  useEffect(() => {
    // Warm the page-scoped cache without blocking workspace startup.
    void loadAIProviderSponsors().catch(() => {});
  }, []);

  const { t: tw } = useTranslation("workspace");
  const { t: tm } = useTranslation("modeling");
  const { t: tp } = useTranslation("projects");
  const resolvedTheme = useWorkspaceUiStore((state) => state.resolvedPreferences.theme);
  const [processor, setProcessor] = useState(() => createProcessor({ ...emptyDocument(), name: tw("untitledScene") }));
  const [revision, setRevision] = useState(0);
  const [currentProjectId, setCurrentProjectId] = useState<string | undefined>();
  const [isDirty, setIsDirty] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [projectsOpen, setProjectsOpen] = useState(false);
  const [projectBusy, setProjectBusy] = useState(false);
  const [transferError, setTransferError] = useState<ProjectFailure | null>(null);
  const [aiPreviewDocument, setAiPreviewDocument] = useState<ModelingDocument | null>(null);
  const [activePanel, setActivePanel] = useState<"viewport" | "scene" | "properties">("viewport");
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [localProjects, setLocalProjects] = useState<LocalProjectSummary[]>([]);
  const [projectError, setProjectError] = useState<ProjectFailure | null>(null);
  const [unsavedDialogOpen, setUnsavedDialogOpen] = useState(false);
  const [projection, setProjection] = useState<ViewProjection>("perspective");
  const [view, setView] = useState<StandardView>("user");
  const [transformTool, setTransformTool] = useState<TransformOperation | null>(null);
  const [error, setError] = useState<{
    commandId: string;
    code: string;
    message: string;
    details: Record<string, unknown>;
  } | null>(null);
  const [nameDraft, setNameDraft] = useState("");
  const [viewportReady, setViewportReady] = useState(false);
  const viewportHostRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<ThreeViewport | null>(null);
  const sessionRef = useRef<TransformSession | null>(null);
  const liveProcessorRef = useRef(processor);
  const liveRevisionRef = useRef(revision);
  const liveProjectIdRef = useRef(currentProjectId);
  const projectMutationRef = useRef(false);
  const pendingReplacementRef = useRef<(() => void) | null>(null);
  const savePromiseRef = useRef<Promise<boolean> | null>(null);
  const projectStore = useMemo(() => providedProjectStore ?? createLocalProjectStore(), [providedProjectStore]);
  const transformConfigRef = useRef<TransformConfiguration>({
    operation: transformTool,
    axis: null,
    snap: true,
    snapStep: transformTool === "rotate" ? 15 : 0.1,
  });
  const setNotice = useWorkspaceUiStore((state) => state.setNotice);
  const notice = useWorkspaceUiStore((state) => state.notice);
  const document = useMemo(() => processor.getDocumentSnapshot(), [processor, revision]);
  const viewportDocument = aiPreviewDocument ?? document;
  const object = selectedObject(document);
  const objectMeshes = useMemo(() => new Map(document.objects.map((object) => [object.id, object.mesh])), [document]);
  const hierarchy = queryModelingDocument(document, "scene.getHierarchy", { limit: 100 }) as {
    items: { id: string; name: string; visible: boolean }[];
  };

  liveProcessorRef.current = processor;
  liveRevisionRef.current = revision;
  liveProjectIdRef.current = currentProjectId;
  transformConfigRef.current = {
    operation: transformTool,
    axis: null,
    snap: true,
    snapStep: transformTool === "rotate" ? 15 : 0.1,
  };

  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  const runCommand = useCallback(
    (commandId: string, args: Record<string, unknown>, success: string) => {
      try {
        liveProcessorRef.current.executeCommand({ commandId, arguments: args });
        setIsDirty(true);
        setNotice(success);
        setError(null);
      } catch (cause) {
        const code = cause && typeof cause === "object" && "code" in cause ? String(cause.code) : "execution-failed";
        const message = describeModelingError(code);
        setNotice(message);
        setError({
          commandId,
          code: cause && typeof cause === "object" && "code" in cause ? String(cause.code) : "execution-failed",
          message,
          details:
            cause && typeof cause === "object" && "details" in cause ? (cause.details as Record<string, unknown>) : {},
        });
      }
      refresh();
    },
    [refresh, setNotice],
  );

  const refreshLocalProjects = useCallback(async () => {
    setProjectsLoading(true);
    setProjectError(null);
    try {
      setLocalProjects(await projectStore.list());
    } catch (cause) {
      setProjectError({ kind: "storage", cause });
    } finally {
      setProjectsLoading(false);
    }
  }, [projectStore]);

  useEffect(() => {
    if (!projectsOpen || projectBusy) return;
    const refreshOnReturn = () => {
      if (window.document.visibilityState === "visible") void refreshLocalProjects();
    };
    window.addEventListener("focus", refreshOnReturn);
    window.document.addEventListener("visibilitychange", refreshOnReturn);
    return () => {
      window.removeEventListener("focus", refreshOnReturn);
      window.document.removeEventListener("visibilitychange", refreshOnReturn);
    };
  }, [projectsOpen, projectBusy, refreshLocalProjects]);

  const saveCurrentProject = useCallback(() => {
    const operation = (async () => {
      const savedRevision = revision;
      setIsSaving(true);
      setProjectError(null);
      try {
        const saved = await projectStore.save(document, currentProjectId);
        setCurrentProjectId(saved.id);
        if (liveRevisionRef.current === savedRevision) setIsDirty(false);
        setNotice("");
        if (projectsOpen) void refreshLocalProjects();
        return true;
      } catch (cause) {
        const message = describeProjectError(cause);
        setProjectError({ kind: "storage", cause });
        setProjectsOpen(true);
        setNotice(message);
        return false;
      } finally {
        setIsSaving(false);
      }
    })();
    savePromiseRef.current = operation;
    void operation.then(
      () => {
        if (savePromiseRef.current === operation) savePromiseRef.current = null;
      },
      () => {
        if (savePromiseRef.current === operation) savePromiseRef.current = null;
      },
    );
    return operation;
  }, [currentProjectId, document, projectStore, projectsOpen, refreshLocalProjects, revision, setNotice]);

  useEffect(() => () => projectStore.close?.(), [projectStore]);

  useEffect(() => {
    if (!notice) return;
    const timeoutId = window.setTimeout(() => setNotice(""), 3000);
    return () => window.clearTimeout(timeoutId);
  }, [notice, setNotice]);

  const requestReplacement = useCallback(
    (replacement: () => void) => {
      if (isDirty) {
        pendingReplacementRef.current = replacement;
        setUnsavedDialogOpen(true);
        return;
      }
      replacement();
    },
    [isDirty],
  );

  const continueReplacement = useCallback(() => {
    const replacement = pendingReplacementRef.current;
    pendingReplacementRef.current = null;
    setUnsavedDialogOpen(false);
    if (replacement) replacement();
  }, []);

  const openLocalProject = useCallback(
    (project: LocalProjectSummary) => {
      setProjectsOpen(false);
      requestReplacement(() => {
        void projectStore
          .load(project.id)
          .then((savedDocument) => {
            setProcessor(createProcessor(savedDocument));
            setCurrentProjectId(project.id);
            setIsDirty(false);
            setProjectsOpen(false);
            setProjectError(null);
            refresh();
            setNotice(i18n.t("opened", { ns: "projects", name: project.name }));
          })
          .catch((cause: unknown) => {
            const message = describeProjectError(cause);
            setProjectError({ kind: "storage", cause });
            setNotice(message);
          });
      });
    },
    [projectStore, refresh, requestReplacement, setNotice],
  );

  async function manageLocalProject(
    project: LocalProjectSummary,
    action: "rename" | "duplicate" | "delete",
    name?: string,
  ) {
    if (projectMutationRef.current || isSaving) return false;
    projectMutationRef.current = true;
    setProjectBusy(true);
    setProjectError(null);
    const startedRevision = liveRevisionRef.current;
    try {
      if (action === "rename") {
        const saved = await projectStore.rename(project.id, name!);
        if (liveProjectIdRef.current === project.id) {
          const remainsDirty = isDirty || liveRevisionRef.current !== startedRevision;
          runCommand("document.rename", { name: saved.name }, tp("renamed"));
          setIsDirty(remainsDirty);
        }
      } else if (action === "duplicate") {
        await projectStore.duplicate(project.id, tp("copyName", { name: project.name }));
      } else {
        await projectStore.remove(project.id);
        if (liveProjectIdRef.current === project.id) {
          setCurrentProjectId(undefined);
          setIsDirty(true);
        }
      }
      setNotice(tp(action === "rename" ? "renamed" : action === "duplicate" ? "duplicated" : "deleted"));
      await refreshLocalProjects();
      return true;
    } catch (cause) {
      setProjectError({ kind: "storage", cause });
      return false;
    } finally {
      projectMutationRef.current = false;
      setProjectBusy(false);
    }
  }

  const exportCurrentProject = useCallback(
    async (format: GltfFormat | "native") => {
      setTransferError(null);
      try {
        let exported;
        if (format === "native") {
          exported = {
            data: serializeNativeProject(document),
            mimeType: "application/vnd.open-3d.project+json",
            extension: "open3d",
            omittedContent: [],
          };
        } else {
          const { exportGltf } = await import("@open-3d/projects/gltf");
          exported = await exportGltf(document, format);
        }
        const blob = new Blob([exported.data as BlobPart], { type: exported.mimeType });
        const url = URL.createObjectURL(blob);
        const anchor = window.document.createElement("a");
        anchor.href = url;
        anchor.download = `${document.name.trim() || "untitled-scene"}.${exported.extension}`;
        anchor.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 0);
        setNotice(
          exported.omittedContent?.length
            ? i18n.t("exportOmitted", { ns: "projects", details: describeOmittedContent(exported.omittedContent) })
            : i18n.t("downloaded", {
                ns: "projects",
                format: format === "native" ? "open3d" : format.toUpperCase(),
              }),
        );
      } catch {
        const message = i18n.t("exportFailed", {
          ns: "projects",
          format: format === "native" ? "open3d" : format.toUpperCase(),
        });
        setTransferError({ kind: "export", format: format === "native" ? "open3d" : format.toUpperCase() });
        setNotice(message);
      }
    },
    [document, setNotice],
  );

  const importProjectFiles = useCallback(
    async (files: File[]) => {
      setTransferError(null);
      try {
        const mainFile = files.find((file) => /\.(open3d|glb|gltf)$/i.test(file.name));
        if (!mainFile) throw new Error("Choose a .open3d, .glb, or .gltf project file.");
        const extension = mainFile.name.split(".").pop()?.toLowerCase();
        const fileData = await mainFile.arrayBuffer();
        let importedDocument: ModelingDocument;
        let omittedContent: string[] = [];
        if (extension === "open3d") {
          importedDocument = deserializeNativeProject(new TextDecoder().decode(fileData));
        } else {
          const { importGltf } = await import("@open-3d/projects/gltf");
          const result = await importGltf(
            new Uint8Array(fileData),
            extension === "glb" ? "glb" : "gltf",
            await Promise.all(
              files
                .filter((file) => file !== mainFile)
                .map(async (file) => ({
                  name: file.name,
                  data: new Uint8Array(await file.arrayBuffer()),
                })),
            ),
          );
          importedDocument = result.document;
          omittedContent = result.omittedContent;
        }
        setProjectsOpen(false);
        requestReplacement(() => {
          setProcessor(createProcessor(importedDocument));
          setCurrentProjectId(undefined);
          setIsDirty(true);
          setProjection(importedDocument.workspace.projection);
          setView("user");
          setProjectError(null);
          setError(null);
          refresh();
          setNotice(
            omittedContent.length
              ? i18n.t("importOmitted", {
                  ns: "projects",
                  name: importedDocument.name,
                  details: describeOmittedContent(omittedContent),
                })
              : i18n.t("imported", { ns: "projects", name: importedDocument.name }),
          );
        });
      } catch (cause) {
        const failure: ProjectFailure = { kind: "import", cause };
        const message = describeProjectFailure(failure);
        setTransferError(failure);
        setNotice(message);
      }
    },
    [refresh, requestReplacement, setNotice],
  );

  useEffect(() => {
    if (!isDirty) return;
    const preventUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", preventUnload);
    return () => window.removeEventListener("beforeunload", preventUnload);
  }, [isDirty]);

  const makeTransformCommand = useCallback(
    (source: ModelingDocument, values: Vec3) => createTransformCommand(source, values, transformConfigRef.current),
    [],
  );

  const transformHandler = useMemo<ViewportTransformHandler>(
    () => ({
      begin() {
        if (!selectedObject(liveProcessorRef.current.getDocumentSnapshot())) return false;
        sessionRef.current = { source: liveProcessorRef.current.getDocumentSnapshot(), values: [0, 0, 0] };
        return true;
      },
      preview(deltaX, deltaY) {
        const session = sessionRef.current;
        const tool = transformConfigRef.current.operation;
        if (!session || !tool) return;
        const factor = tool === "rotate" ? 0.01 : 0.01;
        const delta = tool === "scale" ? 1 + deltaX * factor : deltaX * factor;
        const values: Vec3 = tool === "scale" ? [delta, delta, delta] : [delta, -deltaY * factor, 0];
        session.values = values;
        const command = makeTransformCommand(session.source, values);
        if (!command || !viewportRef.current) return;
        try {
          const preview = createProcessor(session.source);
          preview.executeCommand(command);
          viewportRef.current.setDocument(preview.getDocumentSnapshot());
        } catch {
          viewportRef.current.setDocument(session.source);
        }
      },
      commit() {
        const session = sessionRef.current;
        if (!session) return;
        const command = makeTransformCommand(session.source, session.values);
        if (command) {
          try {
            liveProcessorRef.current.executeCommand(command);
            setIsDirty(true);
          } catch {
            viewportRef.current?.setDocument(session.source);
          }
        }
        sessionRef.current = null;
        refresh();
      },
      cancel() {
        const session = sessionRef.current;
        if (session) viewportRef.current?.setDocument(session.source);
        sessionRef.current = null;
      },
    }),
    [makeTransformCommand, refresh],
  );

  useEffect(() => {
    const host = viewportHostRef.current;
    if (!host) return;
    let disposed = false;
    let viewport: ThreeViewport | undefined;
    void import("@open-3d/viewport-three").then(({ ThreeViewport: Viewport }) => {
      if (disposed) return;
      viewport = new Viewport();
      viewportRef.current = viewport;
      viewport.mount(host);
      viewport.setViewChangeHandler(setView);
      setViewportReady(true);
      viewport.setPickHandler((pick) => {
        const current = liveProcessorRef.current.getDocumentSnapshot();
        if (current.selection.mode === "object") {
          const objectIds = new Set(pick?.extendSelection ? current.selection.objectIds : []);
          if (pick) {
            if (objectIds.has(pick.objectId)) objectIds.delete(pick.objectId);
            else objectIds.add(pick.objectId);
          }
          runCommand(
            "selection.setObjects",
            { objectIds: [...objectIds] },
            objectIds.size
              ? i18n.t("selectionUpdated", { ns: "workspace" })
              : i18n.t("selectionCleared", { ns: "workspace" }),
          );
          return;
        }
        if (!pick) {
          const objectId = current.selection.activeObjectId;
          if (!objectId) return;
          runCommand(
            "selection.setComponents",
            { objectId, mode: current.selection.mode, componentIds: [] },
            i18n.t("selectionCleared", { ns: "workspace" }),
          );
          return;
        }
        const objectId = pick?.objectId ?? current.selection.activeObjectId;
        if (!objectId) return;
        const selectedIds =
          pick?.extendSelection && current.selection.activeObjectId === objectId
            ? new Set(current.selection.componentIds)
            : new Set<string>();
        if (pick?.componentId) {
          if (selectedIds.has(pick.componentId)) selectedIds.delete(pick.componentId);
          else selectedIds.add(pick.componentId);
        }
        runCommand(
          "selection.setComponents",
          {
            objectId,
            mode: current.selection.mode,
            componentIds: [...selectedIds],
          },
          selectedIds.size
            ? i18n.t("componentSelectionUpdated", { ns: "workspace" })
            : i18n.t("selectionCleared", { ns: "workspace" }),
        );
      });
    });
    return () => {
      disposed = true;
      viewport?.dispose();
      viewportRef.current = null;
      setViewportReady(false);
    };
  }, [runCommand]);

  useEffect(() => {
    viewportHostRef.current?.querySelector('[role="application"]')?.setAttribute("aria-label", tw("interactiveScene"));
  }, [viewportReady, tw]);

  useEffect(() => {
    const styles = getComputedStyle(window.document.documentElement);
    const token = (name: string) => styles.getPropertyValue(`--${name}`).trim();
    viewportRef.current?.setAppearance({
      background: token("viewport"),
      grid: token("border"),
      gridMajor: token("input"),
      edge: token("muted"),
    });
  }, [viewportReady, resolvedTheme]);

  useEffect(() => {
    viewportRef.current?.setDocument(viewportDocument);
    viewportRef.current?.setProjection(projection);
    viewportRef.current?.setView(view);
    viewportRef.current?.setTransformHandler(transformTool ? transformHandler : undefined);
  }, [document, projection, transformHandler, transformTool, view, viewportDocument, viewportReady]);

  useEffect(() => {
    setNameDraft(object?.name ?? "");
  }, [object?.id, object?.name]);

  function addPrimitive(primitive: Primitive) {
    runCommand("scene.createPrimitive", { primitive, name: tm(`primitives.${primitive}`) }, tw("objectAdded"));
  }

  function commitTransform(group: "position" | "rotation" | "scale", axis: number, raw: number) {
    const parsed = finiteNumberSchema.safeParse(raw);
    if (!object) return;
    if (!parsed.success) {
      setNotice(tw("finiteNumber"));
      return;
    }
    const transform = structuredClone(object.transform);
    if (group === "rotation") {
      const rotation = quaternionToEuler(object.transform.rotation);
      rotation[axis] = parsed.data;
      transform.rotation = eulerToQuaternion(rotation);
    } else {
      transform[group][axis] = parsed.data;
    }
    runCommand("object.setTransform", { objectId: object.id, transform }, tw("transformUpdated", { group: tw(group) }));
  }

  const objectEuler = object ? quaternionToEuler(object.transform.rotation) : ([0, 0, 0] as Vec3);

  return (
    <main data-panel={activePanel} className="studio flex h-full w-full flex-col overflow-hidden bg-ground">
      <WorkspaceHeader
        documentName={document.name}
        canUndo={processor.canUndo}
        canRedo={processor.canRedo}
        isDirty={isDirty}
        isSaving={isSaving}
        saveDisabled={projectBusy}
        hasLocalSave={currentProjectId !== undefined}
        onUndo={() => {
          if (processor.undo()) {
            setIsDirty(true);
            setNotice(tw("actionUndone"));
            refresh();
          }
        }}
        onRedo={() => {
          if (processor.redo()) {
            setIsDirty(true);
            setNotice(tw("actionRestored"));
            refresh();
          }
        }}
        onSave={() => void saveCurrentProject()}
        onOpenProjects={() => {
          setProjectsOpen(true);
          const pendingSave = savePromiseRef.current;
          void (pendingSave ? pendingSave.then(() => refreshLocalProjects()) : refreshLocalProjects());
        }}
        onRenameProject={(name) => {
          if (name !== document.name) runCommand("document.rename", { name }, tp("renamed"));
        }}
        fileActions={
          <ProjectTransferControls
            onImport={(files) => void importProjectFiles(files)}
            onExport={(format) => void exportCurrentProject(format)}
            error={transferError ? describeProjectFailure(transferError) : null}
            onClearError={() => setTransferError(null)}
          />
        }
      />
      <nav
        className="panel-navigation hidden shrink-0 grid-cols-3 gap-1 bg-ground px-2 py-1"
        aria-label={tw("panelNavigation")}
      >
        {(["scene", "viewport", "properties"] as const).map((panel) => (
          <Button
            key={panel}
            variant="toggle"
            className="h-8"
            aria-pressed={activePanel === panel}
            aria-controls={`${panel}-panel`}
            onClick={() => {
              setActivePanel(panel);
            }}
          >
            {tw(panel === "scene" ? "objects" : panel)}
          </Button>
        ))}
      </nav>
      <div className="workspace-grid grid min-h-0 flex-1 grid-cols-[220px_minmax(0,1fr)_300px] gap-px overflow-hidden pb-3 max-[1000px]:px-2 max-[1120px]:grid-cols-[190px_minmax(0,1fr)_276px] max-[1000px]:grid-cols-1">
        <SceneHierarchyPanel
          onAddPrimitive={addPrimitive}
          items={hierarchy.items.map((item) => ({
            ...item,
            mesh: objectMeshes.get(item.id) ?? null,
          }))}
          activeObjectId={object?.id ?? null}
          selectedObjectIds={document.selection.objectIds}
          onSelectObject={(objectId, name, extendSelection) => {
            const objectIds = new Set(extendSelection ? document.selection.objectIds : []);
            if (objectIds.has(objectId)) objectIds.delete(objectId);
            else objectIds.add(objectId);
            runCommand(
              "selection.setObjects",
              { objectIds: [...objectIds] },
              objectIds.size ? tw("namedSelected", { name }) : i18n.t("selectionCleared", { ns: "workspace" }),
            );
          }}
          onToggleVisibility={(item) =>
            runCommand(
              "object.setVisibility",
              { objectIds: [item.id], visible: !item.visible },
              tw(item.visible ? "objectHidden" : "objectShown", { name: item.name }),
            )
          }
          onDuplicateObject={(item) =>
            runCommand(
              "object.duplicate",
              { objectId: item.id, offset: [0.5, 0.5, 0], name: tw("copyName", { name: item.name }) },
              tw("objectDuplicated", { name: item.name }),
            )
          }
          onDeleteObject={(item) =>
            runCommand("object.delete", { objectIds: [item.id] }, tw("objectDeleted", { name: item.name }))
          }
        />
        <section
          id="viewport-panel"
          className="center-stage flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-sheet"
          data-testid="center-stage"
        >
          <div className="viewport-toolbar flex min-h-[46px] shrink-0 items-center gap-2 px-3 py-1">
            <div className="viewport-tools flex min-w-0 flex-1 flex-wrap items-center justify-between gap-1">
              <div className="flex items-center gap-1">
                {(["perspective", "orthographic"] as ViewProjection[]).map((mode) => (
                  <Button
                    key={mode}
                    variant="toggle"
                    className="tool-button h-[27px] rounded-[5px] border-0 px-[9px] text-[13px]"
                    aria-pressed={projection === mode}
                    onClick={() => setProjection(mode)}
                  >
                    {tw(mode)}
                  </Button>
                ))}
              </div>
              <ViewShortcuts onAlignView={(nextView) => viewportRef.current?.alignView(nextView)} />
            </div>
          </div>
          <div
            className="viewport relative min-h-0 flex-1 overflow-hidden bg-viewport"
            role="region"
            aria-label={tw("viewport")}
            data-testid="viewport"
          >
            <div className="viewport-canvas absolute inset-0" ref={viewportHostRef} />
            {aiPreviewDocument && (
              <div
                className="absolute top-3 left-3 z-[2] rounded border border-warning-border bg-warning-soft px-2 py-1 text-[13px] font-medium text-warning"
                role="status"
              >
                {tw("aiPreview")}
              </div>
            )}
          </div>
          <div className="context-bar flex min-h-[43px] items-center gap-[14px] border-t border-rule px-[13px] max-[860px]:flex-wrap max-[860px]:gap-1.5 max-[860px]:py-1.5 max-[860px]:px-[10px]">
            <div className="context-copy flex min-w-0 flex-1 items-center gap-[7px] text-[13px] text-muted max-[860px]:flex-1">
              <span className="context-indicator size-1.5 rounded-full bg-positive" />
              <span className="min-w-0 truncate">
                {notice ||
                  (object ? (
                    <>
                      <strong className="font-medium text-foreground">{object.name}</strong> {tw("selected")}
                    </>
                  ) : (
                    tw("nothingSelected")
                  ))}
              </span>
            </div>
            <div className="quick-tools flex items-center gap-1 rounded-md bg-soft p-0.5">
              {(["object", "vertex", "edge", "face"] as const).map((mode) => (
                <Button
                  variant="segmented"
                  className="quick-tool h-[23px] rounded px-2 text-[13px]"
                  key={mode}
                  onClick={() =>
                    runCommand(
                      "selection.setMode",
                      { mode, conversion: "convert" },
                      tm("selectionModeUpdated", { mode: tm(`selectionModes.${mode}`) }),
                    )
                  }
                  disabled={mode !== "object" && !object?.mesh}
                  aria-pressed={document.selection.mode === mode}
                >
                  {tm(`selectionModes.${mode}`)}
                </Button>
              ))}
            </div>
            <div className="transform-tools flex items-center gap-0.5 py-0.5 pl-2">
              {(["translate", "rotate", "scale"] as TransformOperation[]).map((tool) => (
                <Button
                  variant="segmented"
                  className="quick-tool h-[23px] rounded px-2 text-[13px]"
                  key={tool}
                  onClick={() => {
                    setTransformTool(transformTool === tool ? null : tool);
                  }}
                  disabled={!object}
                  aria-pressed={transformTool === tool}
                  title={tm("transformPreviewHint")}
                >
                  {tm(`transformTools.${tool}`)}
                </Button>
              ))}
            </div>
          </div>
        </section>
        <aside
          id="properties-panel"
          className="right-panel flex min-h-0 flex-col overflow-hidden bg-ground p-3"
          data-testid="right-panel"
        >
          <div className="properties-content flex min-h-0 flex-1 flex-col overflow-auto">
            <div className="properties-heading flex h-[38px] min-h-[38px] items-start justify-between px-1">
              <h2 className="m-0 text-[15px] font-semibold leading-[19px]">{tw("properties")}</h2>
            </div>
            {!object ? (
              <div className="properties-empty mt-[75px] mx-[15px] grid justify-items-center gap-[7px] text-center text-muted">
                <MousePointer2 className="size-6 text-muted" />
                <strong className="text-[13px] font-medium text-foreground">{tw("selectObject")}</strong>
              </div>
            ) : (
              <>
                <div className="object-summary flex min-h-[57px] items-center gap-[10px] px-1 pt-[5px] pb-3">
                  <div className="summary-glyph grid size-[30px] shrink-0 place-items-center rounded-[7px] bg-soft text-muted">
                    <ObjectIcon mesh={object.mesh} className="size-[19px]" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <Input
                      className="font-medium"
                      aria-label={tw("objectName")}
                      value={nameDraft}
                      onChange={(event) => setNameDraft(event.target.value)}
                      onBlur={() => {
                        const name = nameDraft.trim();
                        if (name && name !== object.name)
                          runCommand("object.rename", { objectId: object.id, name }, tw("objectRenamed"));
                        else if (!name) setNameDraft(object.name);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") event.currentTarget.blur();
                      }}
                    />
                  </div>
                </div>
                <PropertySection title={tw("transform")}>
                  {(["position", "rotation", "scale"] as const).map((group) => {
                    const values = group === "rotation" ? objectEuler : object.transform[group];
                    return (
                      <div className="property-group mt-[11px]" key={group}>
                        <div className="group-label mb-1.5 text-[13px] text-muted">{tw(group)}</div>
                        <div className="axis-fields grid grid-cols-3 gap-[5px]">
                          {values.map((value, axis) => (
                            <label
                              className="value-field flex h-[27px] min-w-0 items-center overflow-hidden rounded-[5px] border border-input bg-sheet focus-within:border-accent"
                              key={axis}
                            >
                              <span className="pl-1.5 text-[13px] text-muted">{["X", "Y", "Z"][axis]}</span>
                              <Input
                                aria-label={tw("transformField", { group: tw(group), axis: ["X", "Y", "Z"][axis] })}
                                className="h-full border-0 bg-transparent dark:bg-transparent px-1 pr-1 text-right text-[13px] shadow-none focus-visible:ring-0"
                                key={`${object.id}-${group}-${axis}-${revision}`}
                                type="number"
                                step="0.1"
                                defaultValue={Number(value.toFixed(3))}
                                onBlur={(event) => commitTransform(group, axis, Number(event.target.value))}
                              />
                            </label>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </PropertySection>
                {error && (
                  <section
                    className="command-error m-2 grid gap-1.5 [overflow-wrap:anywhere] rounded-[5px] border border-negative-border bg-negative-soft p-[9px] text-[13px] leading-[1.4] text-destructive [&_strong]:text-[13px] [&_ul]:m-0 [&_ul]:grid [&_ul]:gap-[5px] [&_ul]:pl-[15px] [&_ul]:text-destructive [&_code]:text-destructive [&_details]:border-t [&_details]:border-negative-border [&_details]:pt-[5px] [&_summary]:cursor-pointer [&_summary]:font-semibold [&_pre]:my-[5px] [&_pre]:max-h-[180px] [&_pre]:overflow-auto [&_pre]:whitespace-pre-wrap [&_pre]:text-[13px]"
                    role="alert"
                  >
                    <strong className="text-[13px]">
                      <code>{error.commandId}</code> · {error.code}
                    </strong>
                    <span>{describeModelingError(error.code)}</span>
                    {Object.keys(error.details).length > 0 && (
                      <details>
                        <summary>{tw("errorDetails")}</summary>
                        <pre>{JSON.stringify(error.details, null, 2)}</pre>
                      </details>
                    )}
                  </section>
                )}
              </>
            )}
          </div>
        </aside>
      </div>
      <LocalProjectsDialog
        open={projectsOpen}
        projects={localProjects}
        currentProjectId={currentProjectId}
        loading={projectsLoading}
        busy={projectBusy || isSaving}
        error={projectError ? describeProjectFailure(projectError) : null}
        onOpenChange={setProjectsOpen}
        onOpenProject={openLocalProject}
        onRenameProject={(project, name) => manageLocalProject(project, "rename", name)}
        onDuplicateProject={(project) => void manageLocalProject(project, "duplicate")}
        onDeleteProject={(project) => manageLocalProject(project, "delete")}
      />
      <AIFloatingWorkspace
        document={document}
        onPreviewDocument={setAiPreviewDocument}
        onAcceptProposal={(commands) => {
          liveProcessorRef.current.executeGroup(commands);
          setAiPreviewDocument(null);
          setIsDirty(true);
          setError(null);
          refresh();
          return liveProcessorRef.current.getDocumentSnapshot();
        }}
      />
      <UnsavedChangesDialog
        open={unsavedDialogOpen}
        onOpenChange={(open) => {
          setUnsavedDialogOpen(open);
          if (!open) pendingReplacementRef.current = null;
        }}
        onSaveAndContinue={() => {
          void saveCurrentProject().then((saved) => {
            if (saved) continueReplacement();
          });
        }}
        onDiscard={continueReplacement}
      />
      <div className="pointer-events-none sr-only" role="status" aria-live="polite">
        {notice}
      </div>
    </main>
  );
}