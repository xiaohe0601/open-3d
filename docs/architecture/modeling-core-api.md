# Modeling Core API

The core package is the renderer-independent source of truth for modeling documents and command/query behavior. Consumers must import from the package root (`@open-3d/model-core`); files under `src/` are implementation details and are not a cross-package API.

## Public Surface

The package root in `packages/model-core/src/index.ts` re-exports the following modules:

| Module | Public API |
| --- | --- |
| `document.ts` | Document and mesh types, `DOCUMENT_SCHEMA_VERSION`, `DocumentValidationError`, `validateModelingDocument`, `serializeModelingDocument`, `deserializeModelingDocument` |
| `commands.ts` | `MODELING_CONTRACT_VERSION`, command/query descriptor types and catalogs, `getModelingOperationCatalog`, descriptor lookup, argument/result validators, `ModelingContractError`, error codes |
| `queries.ts` | Query result types and `queryModelingDocument` |
| `processor.ts` | Command request/receipt/handler types and `ModelingCommandProcessor` |
| `operations.ts` | `createCoreCommandHandlers` for core operations implemented so far |

All public values are serializable data or operations over serializable data. The package does not expose renderer instances, UI state, storage records, or provider-specific types.

## Document Contract

`ModelingDocument` is versioned by `schemaVersion`. V1 contains the document identity/name, scenes, objects, polygon meshes, materials, selection, and workspace view settings. Object, mesh, vertex, edge, face, scene, and material IDs are stable document identities; renderer IDs must not be persisted in their place.

Call `validateModelingDocument(value)` at untrusted input boundaries. It throws `DocumentValidationError` with an `issues` array of `{ path, message }` entries when invariants fail. `serializeModelingDocument(document)` validates and emits canonical JSON; `deserializeModelingDocument(text)` parses, validates, and returns a canonical document. Unsupported schema versions are rejected rather than guessed or migrated.

## Command Contract

`getModelingOperationCatalog()` returns the current `contractVersion`, command descriptors, and query descriptors. A descriptor includes a stable ID, human-readable title/description, JSON-like parameter schema, and (for commands) selection/document preconditions and result shape. Use `getCommandDescriptor(id)` and `getQueryDescriptor(id)` for individual entries. Use `validateCommandArguments(id, args, version?)` and `validateQueryArguments(id, args, version?)` before forwarding requests across a trust boundary.

Successful command handlers return `{ document, result }`. Command results are validated against the descriptor before commit. Invalid IDs, versions, arguments, results, or documents raise `ModelingContractError`; inspect its stable `code`, user-readable `message`, and structured `details`. Unknown catalog entries and unavailable handlers are distinct errors.

The catalog describes the MVP operation surface, while executable handlers are registered as implementation tasks deliver them. A listed command is not necessarily executable yet. The processor does not provide default modeling handlers.

## Queries and History

`queryModelingDocument(document, queryId, args)` is read-only and returns bounded serializable data. Current query IDs are `scene.getHierarchy`, `object.getTransform`, `mesh.getSummary`, `selection.get`, `editor.getMode`, and `operation.getEligibility`. Page-based queries accept limits/cursors where documented by their descriptors.

`ModelingCommandProcessor` validates its initial document and owns a snapshot. Register only implemented handlers with `registerHandler`, or pass them in the constructor. `createCoreCommandHandlers()` implements primitive creation, transforms, selection, extrusion, inset, vertex merge, edge/face dissolve, and component transforms; other catalogued operations return `command-unavailable`. `executeCommand` commits one operation; `executeGroup` stages an ordered group and records it as one history action only after every command succeeds. `undo()` and `redo()` return whether history changed. A failed group leaves the current document, undo history, and redo history unchanged. `getDocumentSnapshot()` returns a defensive clone.

The initial primitive implementation creates a box with 8 vertices/6 quad faces, a UV sphere with `segments` longitude divisions and `max(2, floor(segments / 2))` latitude divisions, or a cylinder with `segments` radial divisions. `size` is the box side length, sphere diameter, or cylinder diameter and height. Defaults are size `2` and segments `16`; `name` defaults to the primitive type. New objects are centered at the origin, receive collision-free deterministic IDs based on the document's current IDs, and become the object selection.

`object.setTransform` replaces position, quaternion rotation, and scale values. `mesh.transformComponents` applies its numeric operation to vertices referenced by the active component selection: translation uses a local-space delta, rotation uses XYZ Euler angles in radians, and scale uses XYZ factors. Unless `pivot` is supplied, rotation and scale use the arithmetic centroid of unique selected vertices. Topology connectivity and component IDs remain unchanged.

`selection.setObjects` replaces the object selection and preserves its current active object when that object remains selected; otherwise the last supplied object becomes active. `selection.setComponents` accepts only unique component IDs present on the requested object and stores them in mesh order. `selection.setMode` with `conversion: "convert"` keeps the active mesh object: object-to-component selects all components of the target kind, component-to-object selects the owning object, and conversions among component modes follow mesh incidence. Vertices map to incident edges/faces, edges map to endpoints/incident faces, and faces map to their vertices/boundary edges. `conversion: "clear"` empties the selection; component modes retain their active mesh owner so the document remains valid. Converting a non-mesh object to a component mode is rejected atomically.

`mesh.extrude` uses `componentIds` from the requested mode and a finite non-zero `distance` and `direction`; direction is normalized before distance is applied. Face mode accepts one connected selected region on a manifold mesh, retains the source faces, adds cap and boundary side faces, and selects the caps. Vertex mode accepts exactly one vertex, adds one translated vertex and connecting edge, and selects the new edge. Edge mode accepts only one open, connected, non-branching chain of boundary edges (one incident face per edge), adds translated chain vertices/edges and bridging quads, and selects those faces. Branches, closed loops, interior/non-boundary edges, disconnected chains, multiple vertex selections, and zero direction/distance are rejected.

`mesh.insetFaces` accepts a connected coplanar face region with one simple boundary loop and a positive `offset`. It offsets the region boundary in its plane, retains the outer boundary, creates inner boundary vertices and ring faces, and selects the inset region. Offsets that collapse, reverse, or self-intersect the inset boundary are rejected without a commit.

`mesh.mergeVertices` requires at least two unique vertex IDs and uses `target: "center"` or `"last-selected"`. It rewires incident edges/faces, removes collapsed edges and faces, deduplicates edges, rejects remaining repeated-vertex or zero-area faces, and selects the retained vertex ID.

`mesh.dissolveEdges` accepts only selected interior manifold edges. `mesh.dissolveFaces` accepts connected selected face regions of at least two faces. Each affected region must reduce to one simple, non-degenerate boundary and use one material; successful regions become one polygon and are selected. Boundary/non-manifold edges, ambiguous boundaries, mixed materials, and edge selections that would remove unselected internal edges are rejected atomically.

`mesh.bevelEdges` accepts isolated manifold edges with two planar incident faces and exactly three incident faces at each endpoint. Width must be shorter than both neighboring endpoint edges; selected bevel regions cannot share endpoints or adjacent faces. `segments` controls the number of chamfer faces, and generated bevel faces become the face selection.

`mesh.loopCut` starts from an `edgeId` and traverses a closed, unbranched loop through non-degenerate quads. `cuts` is from 1 to 64 and `position` is strictly between 0 and 1. A single cut uses `position` directly; multiple cuts are evenly spaced around it at interval `1 / (cuts + 1)` and are rejected if any cut crosses an edge endpoint. Each traversed face is split into `cuts + 1` quads and the generated loop edges are selected.

`mesh.recalculateNormals` orients one closed manifold face component consistently and points its winding outward using signed volume. If the mesh contains multiple disconnected components, select one face in the component to use as the seed; otherwise the component is ambiguous. Open, non-manifold, non-orientable, degenerate, or zero-volume components are rejected. The document stores face winding rather than renderer normals, so a viewport rebuild derives its face normals directly from the committed winding.

`mesh.flipNormals` reverses the vertex order of the requested selected faces. It does not change vertex or edge identities, and preserves the face selection. Both normal operations are atomic and undoable through the standard command processor.

## Executable Example

Run from the repository root after installing the workspace dependencies:

```sh
node apps/web/examples/modeling-core-api.mjs
```

The example imports exclusively from the public package root. It demonstrates catalog discovery, a read-only query, a registered handler, command execution, undo, and redo. Its small rename handler illustrates the extension contract; production mesh handlers are implemented separately.
