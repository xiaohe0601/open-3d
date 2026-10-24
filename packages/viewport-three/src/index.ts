import {
  AmbientLight,
  BufferGeometry,
  Color,
  DirectionalLight,
  Float32BufferAttribute,
  GridHelper,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshStandardMaterial,
  OrthographicCamera,
  PerspectiveCamera,
  Points,
  PointsMaterial,
  Quaternion,
  Raycaster,
  Scene,
  ShapeUtils,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";
import type { ModelingDocument, ModelingObject } from "@open-3d/model-core";

export type StandardView = "user" | "front" | "back" | "left" | "right" | "top" | "bottom";
export type ViewProjection = "perspective" | "orthographic";
export type ViewMode = StandardView | ViewProjection;

export interface ViewportAppearance {
  background: string;
  grid: string;
  gridMajor: string;
  edge: string;
}

const defaultAppearance: ViewportAppearance = {
  background: "#fafafa",
  grid: "#dedede",
  gridMajor: "#888888",
  edge: "#525252",
};

export interface DocumentProjection {
  scene: Scene;
  camera: PerspectiveCamera | OrthographicCamera;
  dispose(): void;
}

export interface ViewportPick {
  objectId: string;
  componentId?: string;
  extendSelection?: boolean;
}

export interface ViewportTransformHandler {
  begin(): boolean;
  preview(deltaX: number, deltaY: number): void;
  commit(): void;
  cancel(): void;
}

export function componentIdAt(
  object: ModelingObject,
  mode: "vertex" | "edge" | "face",
  index: number | undefined,
): string | undefined {
  if (!object.mesh || index === undefined || !Number.isInteger(index) || index < 0) return undefined;
  const components = mode === "vertex" ? object.mesh.vertices : mode === "edge" ? object.mesh.edges : object.mesh.faces;
  return components[index]?.id;
}

export function orbitCameraView(
  camera: PerspectiveCamera | OrthographicCamera,
  target: Vector3,
  deltaX: number,
  deltaY: number,
): void {
  const offset = camera.position.clone().sub(target);
  const radius = Math.max(0.05, offset.length());
  const azimuth = Math.atan2(offset.y, offset.x) - deltaX * 0.005;
  let elevation = Math.asin(Math.max(-1, Math.min(1, offset.z / radius))) + deltaY * 0.005;
  elevation = Math.max(-Math.PI / 2 + 0.02, Math.min(Math.PI / 2 - 0.02, elevation));
  offset.set(
    radius * Math.cos(elevation) * Math.cos(azimuth),
    radius * Math.cos(elevation) * Math.sin(azimuth),
    radius * Math.sin(elevation),
  );
  camera.position.copy(target).add(offset);
  camera.up.set(0, 0, 1);
  camera.lookAt(target);
}

export function panCameraView(
  camera: PerspectiveCamera | OrthographicCamera,
  target: Vector3,
  deltaX: number,
  deltaY: number,
  viewportHeight: number,
): void {
  const height = Math.max(1, viewportHeight);
  const distance = camera.position.distanceTo(target);
  const worldUnitsPerPixel =
    camera instanceof OrthographicCamera
      ? (camera.top - camera.bottom) / (camera.zoom * height)
      : (2 * distance * Math.tan((camera.fov * Math.PI) / 180 / 2)) / height;
  const right = new Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
  const up = new Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
  const movement = right
    .multiplyScalar(-deltaX * worldUnitsPerPixel)
    .add(up.multiplyScalar(deltaY * worldUnitsPerPixel));
  target.add(movement);
  camera.position.add(movement);
  camera.lookAt(target);
}

export function zoomCameraView(camera: PerspectiveCamera | OrthographicCamera, target: Vector3, deltaY: number): void {
  const factor = Math.exp(deltaY * 0.001);
  if (camera instanceof PerspectiveCamera) {
    const offset = camera.position.clone().sub(target);
    const distance = Math.max(0.05, Math.min(100000, offset.length() * factor));
    camera.position.copy(target).add(offset.normalize().multiplyScalar(distance));
  } else {
    camera.zoom = Math.max(0.05, Math.min(100, camera.zoom / factor));
    camera.updateProjectionMatrix();
  }
}

function faceTriangles(object: ModelingObject): { indices: number[]; faceIds: string[] } {
  const mesh = object.mesh;
  if (!mesh) return { indices: [], faceIds: [] };
  const vertexIndex = new Map(mesh.vertices.map((vertex, index) => [vertex.id, index]));
  const positions = mesh.vertices.map((vertex) => vertex.position);
  const indices: number[] = [];
  const faceIds: string[] = [];

  for (const face of mesh.faces) {
    const faceVertexIndices = face.vertexIds.map((id) => vertexIndex.get(id)!);
    if (faceVertexIndices.length === 3) {
      indices.push(...faceVertexIndices);
      faceIds.push(face.id);
      continue;
    }
    const contour = faceVertexIndices.map((index) => positions[index]);
    let normalX = 0;
    let normalY = 0;
    let normalZ = 0;
    for (let index = 0; index < contour.length; index += 1) {
      const current = contour[index];
      const next = contour[(index + 1) % contour.length];
      normalX += (current[1] - next[1]) * (current[2] + next[2]);
      normalY += (current[2] - next[2]) * (current[0] + next[0]);
      normalZ += (current[0] - next[0]) * (current[1] + next[1]);
    }
    let convex = contour.length === 4;
    const normalLength = Math.hypot(normalX, normalY, normalZ);
    if (convex && normalLength > 0) {
      const origin = contour[0];
      let extent = 1;
      for (const point of contour.slice(1)) {
        extent = Math.max(
          extent,
          Math.abs(point[0] - origin[0]),
          Math.abs(point[1] - origin[1]),
          Math.abs(point[2] - origin[2]),
        );
      }
      for (const point of contour.slice(1)) {
        const deltaX = point[0] - origin[0];
        const deltaY = point[1] - origin[1];
        const deltaZ = point[2] - origin[2];
        if (Math.abs(normalX * deltaX + normalY * deltaY + normalZ * deltaZ) > normalLength * extent * 1e-8) {
          convex = false;
          break;
        }
      }
    } else {
      convex = false;
    }
    let orientation = 0;
    if (convex) {
      for (let index = 0; index < contour.length; index += 1) {
        const current = contour[index];
        const next = contour[(index + 1) % contour.length];
        const after = contour[(index + 2) % contour.length];
        const edge1X = next[0] - current[0];
        const edge1Y = next[1] - current[1];
        const edge1Z = next[2] - current[2];
        const edge2X = after[0] - next[0];
        const edge2Y = after[1] - next[1];
        const edge2Z = after[2] - next[2];
        const cross =
          (edge1Y * edge2Z - edge1Z * edge2Y) * normalX +
          (edge1Z * edge2X - edge1X * edge2Z) * normalY +
          (edge1X * edge2Y - edge1Y * edge2X) * normalZ;
        if (Math.abs(cross) <= normalLength * 1e-12) {
          convex = false;
          break;
        }
        const sign = Math.sign(cross);
        if (orientation && sign !== orientation) {
          convex = false;
          break;
        }
        orientation = sign;
      }
    }
    let localTriangles: number[][];
    if (convex) {
      localTriangles = [
        [0, 1, 2],
        [0, 2, 3],
      ];
    } else {
      const axis =
        Math.abs(normalX) > Math.abs(normalY)
          ? Math.abs(normalX) > Math.abs(normalZ)
            ? "x"
            : "z"
          : Math.abs(normalY) > Math.abs(normalZ)
            ? "y"
            : "z";
      const points = contour.map((point) =>
        axis === "x"
          ? new Vector2(point[1], point[2])
          : axis === "y"
            ? new Vector2(point[0], point[2])
            : new Vector2(point[0], point[1]),
      );
      localTriangles = ShapeUtils.triangulateShape(points, []);
    }
    for (const triangle of localTriangles) {
      indices.push(faceVertexIndices[triangle[0]], faceVertexIndices[triangle[1]], faceVertexIndices[triangle[2]]);
      faceIds.push(face.id);
    }
  }
  return { indices, faceIds };
}

function addMeshProjection(
  group: Group,
  object: ModelingObject,
  materials: Map<string, ModelingDocument["materials"][number]>,
  materialCache: Map<string, MeshStandardMaterial>,
  selectionMode: ModelingDocument["selection"]["mode"],
  selectedIds: ReadonlySet<string>,
  resources: { geometries: BufferGeometry[]; materials: (MeshStandardMaterial | LineBasicMaterial | PointsMaterial)[] },
  appearance: ViewportAppearance,
): void {
  if (!object.mesh || object.mesh.vertices.length === 0) return;
  const positions = object.mesh.vertices.flatMap(({ position }) => position);
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  const projectedFaces = faceTriangles(object);
  geometry.setIndex(projectedFaces.indices);
  geometry.computeVertexNormals();
  geometry.clearGroups();
  resources.geometries.push(geometry);

  const defaultMaterial = "__default__";
  const getMaterial = (materialId: string | null): MeshStandardMaterial => {
    const key = materialId ?? defaultMaterial;
    const cached = materialCache.get(key);
    if (cached) return cached;
    const material = materials.get(key);
    const color = material?.baseColor ?? [0.66, 0.72, 0.69, 1];
    const result = new MeshStandardMaterial({
      color: new Color(color[0], color[1], color[2]),
      metalness: material?.metallic ?? 0.05,
      roughness: material?.roughness ?? 0.72,
      side: 2,
      flatShading: true,
    });
    materialCache.set(key, result);
    resources.materials.push(result);
    return result;
  };
  const materialIds: string[] = [];
  const materialsForMesh: MeshStandardMaterial[] = [];
  const indexForMaterial = (materialId: string | null): number => {
    const key = materialId ?? defaultMaterial;
    let index = materialIds.indexOf(key);
    if (index < 0) {
      index = materialIds.length;
      materialIds.push(key);
      materialsForMesh.push(getMaterial(materialId));
    }
    return index;
  };
  let faceStart = 0;
  let groupStart = 0;
  let groupCount = 0;
  let groupMaterialIndex = -1;
  for (const face of object.mesh.faces) {
    const faceCount = (face.vertexIds.length - 2) * 3;
    const materialIndex = indexForMaterial(face.materialId);
    if (groupMaterialIndex !== materialIndex) {
      if (groupCount > 0) geometry.addGroup(groupStart, groupCount, groupMaterialIndex);
      groupStart = faceStart;
      groupCount = faceCount;
      groupMaterialIndex = materialIndex;
    } else {
      groupCount += faceCount;
    }
    faceStart += faceCount;
  }
  if (groupCount > 0) geometry.addGroup(groupStart, groupCount, groupMaterialIndex);
  if (object.mesh.faces.length === 0) indexForMaterial(null);
  const surfaceMaterial = materialsForMesh.length > 1 ? materialsForMesh : materialsForMesh[0];
  const surface = new Mesh(geometry, surfaceMaterial);
  surface.userData.documentObjectId = object.id;
  surface.userData.faceIdsByTriangle = projectedFaces.faceIds;
  group.add(surface);

  const vertexIndex = new Map(object.mesh.vertices.map((vertex, index) => [vertex.id, index]));
  const edgePositions: number[] = [];
  for (const edge of object.mesh.edges) {
    const from = object.mesh.vertices[vertexIndex.get(edge.vertexIds[0])!].position;
    const to = object.mesh.vertices[vertexIndex.get(edge.vertexIds[1])!].position;
    edgePositions.push(...from, ...to);
  }
  const edgeGeometry = new BufferGeometry();
  edgeGeometry.setAttribute("position", new Float32BufferAttribute(edgePositions, 3));
  const edgeMaterial = new LineBasicMaterial({ color: appearance.edge });
  resources.geometries.push(edgeGeometry);
  resources.materials.push(edgeMaterial);
  const edges = new LineSegments(edgeGeometry, edgeMaterial);
  edges.userData.documentObjectId = object.id;
  edges.userData.edgeIds = object.mesh.edges.map(({ id }) => id);
  group.add(edges);

  if (selectionMode === "vertex") {
    const pointGeometry = new BufferGeometry();
    pointGeometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
    resources.geometries.push(pointGeometry);
    const pointsMaterial = new PointsMaterial({ color: appearance.edge, size: 7, sizeAttenuation: false });
    resources.materials.push(pointsMaterial);
    const vertexPoints = new Points(pointGeometry, pointsMaterial);
    vertexPoints.userData.documentObjectId = object.id;
    vertexPoints.userData.vertexIds = object.mesh.vertices.map(({ id }) => id);
    group.add(vertexPoints);
    const selectedVertices = object.mesh.vertices.filter(({ id }) => selectedIds.has(id));
    if (selectedVertices.length > 0) {
      const selectedGeometry = new BufferGeometry();
      selectedGeometry.setAttribute(
        "position",
        new Float32BufferAttribute(
          selectedVertices.flatMap(({ position }) => position),
          3,
        ),
      );
      const selectedMaterial = new PointsMaterial({ color: 0xd17d3a, size: 11, sizeAttenuation: false });
      resources.geometries.push(selectedGeometry);
      resources.materials.push(selectedMaterial);
      const selectedPoints = new Points(selectedGeometry, selectedMaterial);
      selectedPoints.userData.documentObjectId = object.id;
      selectedPoints.userData.vertexIds = selectedVertices.map(({ id }) => id);
      group.add(selectedPoints);
    }
  } else if (selectionMode === "edge" && selectedIds.size > 0) {
    const selectedPositions: number[] = [];
    for (const edge of object.mesh.edges) {
      if (!selectedIds.has(edge.id)) continue;
      selectedPositions.push(
        ...object.mesh.vertices[vertexIndex.get(edge.vertexIds[0])!].position,
        ...object.mesh.vertices[vertexIndex.get(edge.vertexIds[1])!].position,
      );
    }
    if (selectedPositions.length > 0) {
      const selectedGeometry = new BufferGeometry();
      selectedGeometry.setAttribute("position", new Float32BufferAttribute(selectedPositions, 3));
      const selectedMaterial = new LineBasicMaterial({ color: 0xd17d3a });
      resources.geometries.push(selectedGeometry);
      resources.materials.push(selectedMaterial);
      const selectedEdges = new LineSegments(selectedGeometry, selectedMaterial);
      selectedEdges.userData.documentObjectId = object.id;
      selectedEdges.userData.edgeIds = object.mesh.edges.filter(({ id }) => selectedIds.has(id)).map(({ id }) => id);
      group.add(selectedEdges);
    }
  }
  if (selectionMode === "face" && selectedIds.size > 0) {
    const selectedTriangles = projectedFaces.faceIds.flatMap((id, triangleIndex) =>
      selectedIds.has(id) ? [triangleIndex] : [],
    );
    const selectedIndices = selectedTriangles.flatMap((triangleIndex) =>
      projectedFaces.indices.slice(triangleIndex * 3, triangleIndex * 3 + 3),
    );
    if (selectedIndices.length > 0) {
      const selectedGeometry = new BufferGeometry();
      selectedGeometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
      selectedGeometry.setIndex(selectedIndices);
      selectedGeometry.computeVertexNormals();
      const selectedMaterial = new MeshStandardMaterial({
        color: 0xd17d3a,
        transparent: true,
        opacity: 0.42,
        side: 2,
        depthWrite: false,
      });
      resources.geometries.push(selectedGeometry);
      resources.materials.push(selectedMaterial);
      const selectedFaces = new Mesh(selectedGeometry, selectedMaterial);
      selectedFaces.userData.documentObjectId = object.id;
      group.add(selectedFaces);
    }
  }
}

function cameraFor(
  document: ModelingDocument,
  aspect: number,
  view: StandardView,
  projection: ViewProjection,
): PerspectiveCamera | OrthographicCamera {
  const { workspace } = document;
  const target = new Vector3(...workspace.cameraTarget);
  const distance = Math.max(0.1, new Vector3(...workspace.cameraPosition).distanceTo(target));
  const directions: Record<Exclude<StandardView, "user">, [number, number, number]> = {
    front: [0, -1, 0],
    back: [0, 1, 0],
    left: [-1, 0, 0],
    right: [1, 0, 0],
    top: [0, 0, 1],
    bottom: [0, 0, -1],
  };
  const position =
    view === "user"
      ? new Vector3(...workspace.cameraPosition)
      : target.clone().add(new Vector3(...directions[view]).multiplyScalar(distance));
  const up = view === "top" || view === "bottom" ? new Vector3(0, 1, 0) : new Vector3(0, 0, 1);

  if (projection === "orthographic") {
    const halfHeight = workspace.orthographicScale / 2;
    const camera = new OrthographicCamera(
      -halfHeight * aspect,
      halfHeight * aspect,
      halfHeight,
      -halfHeight,
      0.01,
      Math.max(1000, distance * 100),
    );
    camera.position.copy(position);
    camera.up.copy(up);
    camera.lookAt(target);
    camera.updateProjectionMatrix();
    return camera;
  }

  const camera = new PerspectiveCamera(workspace.fieldOfView, aspect, 0.01, Math.max(1000, distance * 100));
  camera.position.copy(position);
  camera.up.copy(up);
  camera.lookAt(target);
  camera.updateProjectionMatrix();
  return camera;
}

export function buildDocumentProjection(
  document: ModelingDocument,
  options: { aspect?: number; view?: StandardView; projection?: ViewProjection; appearance?: ViewportAppearance } = {},
): DocumentProjection {
  const appearance = options.appearance ?? defaultAppearance;
  const aspect = options.aspect ?? 1;
  const scene = new Scene();
  scene.background = new Color(appearance.background);
  scene.add(new AmbientLight(0xffffff, 1.5));
  const key = new DirectionalLight(0xffffff, 2.1);
  key.position.set(-4, -6, 10);
  scene.add(key);

  const resources: {
    geometries: BufferGeometry[];
    materials: (MeshStandardMaterial | LineBasicMaterial | PointsMaterial)[];
  } = {
    geometries: [],
    materials: [],
  };
  const groups = new Map<string, Group>();
  const documentMaterials = new Map(document.materials.map((item) => [item.id, item]));
  const materialCache = new Map<string, MeshStandardMaterial>();
  for (const object of document.objects) {
    const group = new Group();
    group.name = object.name;
    group.userData.documentObjectId = object.id;
    group.position.set(...object.transform.position);
    group.quaternion.copy(new Quaternion(...object.transform.rotation));
    group.scale.set(...object.transform.scale);
    group.visible = object.visible;
    const selection = document.selection;
    addMeshProjection(
      group,
      object,
      documentMaterials,
      materialCache,
      selection.mode,
      selection.activeObjectId === object.id ? new Set(selection.componentIds) : new Set(),
      resources,
      appearance,
    );
    groups.set(object.id, group);
  }
  for (const object of document.objects) {
    const parent = object.parentId ? groups.get(object.parentId) : undefined;
    (parent ?? scene).add(groups.get(object.id)!);
  }
  // A simple document-space grid uses Z-up to match the modeling coordinate system.
  if (document.workspace.showGrid) {
    const grid = new GridHelper(100, 100, appearance.gridMajor, appearance.grid);
    grid.rotation.x = Math.PI / 2;
    grid.position.z = -0.001;
    scene.add(grid);
  }
  if (document.workspace.showAxes) {
    const axesGeometry = new BufferGeometry();
    axesGeometry.setAttribute(
      "position",
      new Float32BufferAttribute([0, 0, 0, 5, 0, 0, 0, 0, 0, 0, 5, 0, 0, 0, 0, 0, 0, 5], 3),
    );
    const axes = new LineSegments(axesGeometry, [
      new LineBasicMaterial({ color: 0xc85f58 }),
      new LineBasicMaterial({ color: 0x57916f }),
      new LineBasicMaterial({ color: 0x397c94 }),
    ]);
    axes.name = "World axes";
    resources.geometries.push(axesGeometry);
    resources.materials.push(...axes.material);
    scene.add(axes);
  }

  return {
    scene,
    camera: cameraFor(document, aspect, options.view ?? "user", options.projection ?? document.workspace.projection),
    dispose() {
      resources.geometries.forEach((geometry) => geometry.dispose());
      resources.materials.forEach((material) => material.dispose());
    },
  };
}

export class ThreeViewport {
  private appearance = defaultAppearance;
  private readonly renderer = new WebGLRenderer({ antialias: true, alpha: false });
  private resizeObserver: ResizeObserver | undefined;
  private document: ModelingDocument | undefined;
  private projection: DocumentProjection | undefined;
  private view: StandardView = "user";
  private projectionMode: ViewProjection = "perspective";
  private host: HTMLElement | undefined;
  private pickHandler: ((pick: ViewportPick | null) => void) | undefined;
  private viewChangeHandler: ((view: StandardView) => void) | undefined;
  private transformHandler: ViewportTransformHandler | undefined;
  private target = new Vector3();
  private cameraState: { position: Vector3; target: Vector3; up: Vector3; zoom: number } | undefined;
  private pointerGesture:
    | {
        pointerId: number;
        startX: number;
        startY: number;
        lastX: number;
        lastY: number;
        button: number;
        shiftKey: boolean;
        moved: boolean;
        transforming: boolean;
      }
    | undefined;
  private readonly raycaster = new Raycaster();

  constructor() {
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = "srgb";
    this.renderer.setClearColor(defaultAppearance.background);
    const canvas = this.renderer.domElement;
    canvas.setAttribute("role", "application");
    canvas.setAttribute("aria-label", "Interactive 3D scene");
    canvas.tabIndex = 0;
    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("pointercancel", this.onPointerCancel);
    canvas.addEventListener("keydown", this.onKeyDown);
    canvas.addEventListener("contextmenu", this.onContextMenu);
    canvas.addEventListener("wheel", this.onWheel, { passive: false });
  }

  mount(host: HTMLElement): void {
    if (this.host === host) return;
    this.resizeObserver?.disconnect();
    this.host = host;
    host.append(this.renderer.domElement);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.resize();
  }

  setDocument(document: ModelingDocument): void {
    this.document = document;
    if (!this.cameraState) this.target.fromArray(document.workspace.cameraTarget);
    this.rebuild();
  }

  setAppearance(appearance: ViewportAppearance): void {
    this.appearance = appearance;
    this.rebuild();
  }

  setView(view: StandardView): void {
    if (view === this.view) return;
    this.alignView(view);
  }

  alignView(view: StandardView): void {
    this.view = view;
    this.cameraState = undefined;
    if (this.document) this.target.fromArray(this.document.workspace.cameraTarget);
    this.rebuild(true);
    this.viewChangeHandler?.(view);
  }

  setViewChangeHandler(handler: (view: StandardView) => void): void {
    this.viewChangeHandler = handler;
  }

  setProjection(projection: ViewProjection): void {
    if (projection === this.projectionMode) return;
    this.projectionMode = projection;
    this.rebuild();
  }

  setPickHandler(handler: (pick: ViewportPick | null) => void): void {
    this.pickHandler = handler;
  }

  setTransformHandler(handler: ViewportTransformHandler | undefined): void {
    this.transformHandler = handler;
  }

  async capture(maxDimension = 1024): Promise<Blob> {
    if (
      !this.host ||
      !this.projection ||
      this.renderer.getContext().isContextLost() ||
      !Number.isFinite(maxDimension) ||
      maxDimension < 1 ||
      maxDimension > 2048
    )
      throw new Error("viewport-capture-unavailable");
    const source = this.renderer.domElement;
    if (!source.width || !source.height) throw new Error("viewport-capture-unavailable");
    const scale = Math.min(1, maxDimension / Math.max(source.width, source.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(source.width * scale));
    canvas.height = Math.max(1, Math.round(source.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("viewport-capture-unavailable");
    // Copy synchronously after rendering: the WebGL drawing buffer is not preserved.
    this.renderer.render(this.projection.scene, this.projection.camera);
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (value) => (value ? resolve(value) : reject(new Error("viewport-capture-unavailable"))),
        "image/jpeg",
        0.9,
      );
    });
    if (!blob.size || blob.size > 5 * 1024 * 1024) throw new Error("viewport-capture-size");
    return blob;
  }

  dispose(): void {
    this.viewChangeHandler = undefined;
    this.resizeObserver?.disconnect();
    this.projection?.dispose();
    const canvas = this.renderer.domElement;
    canvas.removeEventListener("pointerdown", this.onPointerDown);
    canvas.removeEventListener("pointermove", this.onPointerMove);
    canvas.removeEventListener("pointerup", this.onPointerUp);
    canvas.removeEventListener("pointercancel", this.onPointerCancel);
    canvas.removeEventListener("keydown", this.onKeyDown);
    canvas.removeEventListener("contextmenu", this.onContextMenu);
    canvas.removeEventListener("wheel", this.onWheel);
    this.renderer.dispose();
  }

  private resize(): void {
    if (!this.host) return;
    const { width, height } = this.host.getBoundingClientRect();
    if (!width || !height) return;
    this.renderer.setSize(width, height, false);
    this.rebuild();
  }

  private rebuild(resetCamera = false): void {
    if (!this.document || !this.host) return;
    const previousCamera = this.projection?.camera;
    this.projection?.dispose();
    const { width, height } = this.host.getBoundingClientRect();
    if (!width || !height) return;
    this.projection = buildDocumentProjection(this.document, {
      aspect: width / height,
      projection: this.projectionMode,
      view: this.view,
      appearance: this.appearance,
    });
    if (!resetCamera && this.cameraState) {
      this.projection.camera.position.copy(this.cameraState.position);
      this.projection.camera.up.copy(this.cameraState.up);
      this.projection.camera.zoom = this.cameraState.zoom;
      this.projection.camera.lookAt(this.cameraState.target);
      this.projection.camera.updateProjectionMatrix();
    } else if (!resetCamera && previousCamera && this.view === "user") {
      this.projection.camera.position.copy(previousCamera.position);
      this.projection.camera.up.copy(previousCamera.up);
      this.projection.camera.zoom = previousCamera.zoom;
      this.projection.camera.lookAt(this.target);
      this.projection.camera.updateProjectionMatrix();
    }
    this.renderer.render(this.projection.scene, this.projection.camera);
  }

  private rememberCamera(): void {
    const camera = this.projection?.camera;
    if (!camera) return;
    this.cameraState = {
      position: camera.position.clone(),
      target: this.target.clone(),
      up: camera.up.clone(),
      zoom: camera.zoom,
    };
  }

  private onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 && event.button !== 1 && event.button !== 2) return;
    event.preventDefault();
    this.renderer.domElement.setPointerCapture(event.pointerId);
    this.pointerGesture = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      button: event.button,
      shiftKey: event.shiftKey,
      moved: false,
      transforming: false,
    };
  };

  private onPointerMove = (event: PointerEvent): void => {
    const gesture = this.pointerGesture;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const deltaX = event.clientX - gesture.lastX;
    const deltaY = event.clientY - gesture.lastY;
    gesture.lastX = event.clientX;
    gesture.lastY = event.clientY;
    if (Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) > 3) gesture.moved = true;
    if (!gesture.moved) return;
    if (gesture.button === 0 && this.transformHandler) {
      if (!gesture.transforming) gesture.transforming = this.transformHandler.begin();
      if (gesture.transforming) {
        this.transformHandler.preview(event.clientX - gesture.startX, event.clientY - gesture.startY);
        return;
      }
    }
    if (gesture.button === 0) return;
    if (gesture.button === 1 && !gesture.shiftKey) this.orbit(deltaX, deltaY);
    else this.pan(deltaX, deltaY);
    this.renderer.domElement.classList.add("is-navigating");
  };

  private onPointerUp = (event: PointerEvent): void => {
    const gesture = this.pointerGesture;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    this.pointerGesture = undefined;
    if (this.renderer.domElement.hasPointerCapture(event.pointerId)) {
      this.renderer.domElement.releasePointerCapture(event.pointerId);
    }
    this.renderer.domElement.classList.remove("is-navigating");
    if (gesture.transforming) this.transformHandler?.commit();
    else if (gesture.button === 0 && !gesture.moved) this.pick(event.clientX, event.clientY, event.shiftKey);
  };

  private onPointerCancel = (event: PointerEvent): void => {
    if (this.pointerGesture?.pointerId !== event.pointerId) return;
    if (this.pointerGesture.transforming) this.transformHandler?.cancel();
    this.pointerGesture = undefined;
    this.renderer.domElement.classList.remove("is-navigating");
  };

  private onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape" || !this.pointerGesture?.transforming) return;
    event.preventDefault();
    this.pointerGesture = undefined;
    this.transformHandler?.cancel();
    this.renderer.domElement.classList.remove("is-navigating");
  };

  private onContextMenu = (event: MouseEvent): void => event.preventDefault();

  private onWheel = (event: WheelEvent): void => {
    if (!this.projection) return;
    event.preventDefault();
    const camera = this.projection.camera;
    zoomCameraView(camera, this.target, event.deltaY);
    this.rememberCamera();
    this.renderer.render(this.projection.scene, camera);
  };

  private orbit(deltaX: number, deltaY: number): void {
    if (!this.projection) return;
    const camera = this.projection.camera;
    orbitCameraView(camera, this.target, deltaX, deltaY);
    this.rememberCamera();
    if (this.view !== "user") {
      this.view = "user";
      this.viewChangeHandler?.("user");
    }
    this.renderer.render(this.projection.scene, camera);
  }

  private pan(deltaX: number, deltaY: number): void {
    if (!this.projection || !this.host) return;
    const camera = this.projection.camera;
    panCameraView(camera, this.target, deltaX, deltaY, this.host.getBoundingClientRect().height);
    this.rememberCamera();
    this.renderer.render(this.projection.scene, camera);
  }

  private pick(clientX: number, clientY: number, extendSelection: boolean): void {
    if (!this.document || !this.projection || !this.host || !this.pickHandler) return;
    const bounds = this.renderer.domElement.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    const pointer = new Vector2(
      ((clientX - bounds.left) / bounds.width) * 2 - 1,
      -((clientY - bounds.top) / bounds.height) * 2 + 1,
    );
    this.raycaster.params.Line.threshold = Math.max(
      0.02,
      (this.projection.camera.position.distanceTo(this.target) / bounds.height) * 0.012,
    );
    this.raycaster.params.Points.threshold = Math.max(
      0.04,
      (this.projection.camera.position.distanceTo(this.target) / bounds.height) * 0.018,
    );
    this.raycaster.setFromCamera(pointer, this.projection.camera);
    const hits = this.raycaster.intersectObjects(this.projection.scene.children, true);
    const mode = this.document.selection.mode;
    for (const hit of hits) {
      let objectId: string | undefined;
      for (let node: typeof hit.object | null = hit.object; node; node = node.parent) {
        if (typeof node.userData.documentObjectId === "string") {
          objectId = node.userData.documentObjectId;
          break;
        }
      }
      if (!objectId) continue;
      if (mode === "object") {
        this.pickHandler({ objectId, extendSelection });
        return;
      }
      const object = this.document.objects.find((item) => item.id === objectId);
      if (!object?.mesh) continue;
      let componentId: string | undefined;
      if (mode === "vertex" && hit.object instanceof Points) {
        componentId = (hit.object.userData.vertexIds as string[] | undefined)?.[hit.index ?? -1];
      } else if (mode === "edge" && hit.object instanceof LineSegments) {
        const edgeIndex = Math.floor((hit.index ?? -1) / 2);
        componentId =
          (hit.object.userData.edgeIds as string[] | undefined)?.[edgeIndex] ?? componentIdAt(object, mode, edgeIndex);
      } else if (mode === "face" && hit.object instanceof Mesh && typeof hit.faceIndex === "number") {
        const faceIds = hit.object.userData.faceIdsByTriangle as string[] | undefined;
        componentId = faceIds?.[hit.faceIndex];
      }
      if (componentId) {
        this.pickHandler({ objectId, componentId, extendSelection });
        return;
      }
    }
    if (!extendSelection) this.pickHandler(null);
  }
}