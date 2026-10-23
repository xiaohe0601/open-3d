# MVP Topology Contracts

These are validation-stage contracts, not geometry algorithms. The machine-readable examples live in `tests/fixtures/topology/contracts.mjs`; their completeness and required input classes are checked by `contracts.test.mjs`.

All rejected operations must leave geometry, selection, and undo history unchanged. Accepted operations are deterministic for the same document, selection, and parameters. Component identities affected by topology changes are regenerated or retained according to the operation result contract; stale identities must not remain selected.

## Supported Operations

| Operation | MVP eligibility and parameters | Expected result |
| --- | --- | --- |
| Vertex extrusion | Exactly one selected vertex and a finite non-zero distance along a finite, non-zero direction. Direction is normalized before applying distance. | Duplicate the vertex at the translated position, add one connecting edge, and select that edge. |
| Edge extrusion | One open, connected, non-branching chain of selected boundary edges, each incident to exactly one face; finite non-zero distance and direction. Closed loops, branches, interior edges, mixed chains, and zero direction are rejected. | Duplicate the chain vertices, retain the source boundary, create translated chain edges and connector edges, bridge each source edge with a quad, and select the generated faces. |
| Face extrusion | One connected selected face region on a manifold surface; finite non-zero distance and direction. The selected region boundary is the set of edges with one selected and at most two total incident faces. Direction is normalized before applying distance. | Retain the source region, create translated cap faces and side faces along the region boundary, and select the cap region. |
| Face inset | One connected coplanar region with one simple boundary loop, positive-area faces, and a finite positive offset that does not collapse, reverse, or self-intersect the inset boundary. | Clone and offset the region boundary, retain the outer boundary, create surrounding boundary faces, and select the inset region. |
| Vertex merge | At least two distinct selected vertices; target is `center` or `last-selected`. Reject results that leave unsupported degeneracy after degenerate incident elements are removed. | Replace selected vertices by one deterministic target vertex, rewire incident topology, remove collapsed edges/faces and duplicate edges, and select the merged vertex. |
| Edge dissolve | Selected edges must be interior manifold edges; each affected connected face region must have one simple, non-degenerate boundary, and every internal edge removed by the merge must be selected. Faces in a merged region must share one material. `preserveBoundary` defaults to true. | Remove selected internal edges, merge the incident region into a polygon, retain its outer boundary, and select resulting faces. |
| Face dissolve | Each selected connected face region must contain at least two faces and have one simple, non-degenerate boundary. All faces in each region must share one material. | Remove internal edges and replace each selected connected region with one polygon using its existing outer boundary; select the resulting faces. |
| Edge bevel | Selected manifold edges with two planar incident faces, exactly three incident faces at each endpoint, finite positive width shorter than the adjacent endpoint edges, and integer segment count from 1 to 32. Selected bevels cannot share endpoints or adjacent faces. | Create a deterministic chamfer strip with the requested number of segments, preserve valid surrounding faces, and select generated bevel faces. Boundary/non-manifold edges, competing bevels, junctions, degenerate meshes, and excessive widths are rejected. |
| Quad loop cut | A seed edge traverses one closed, unbranched loop through non-degenerate quads only; positive integer cut count and normalized center position in `(0, 1)`. | Split each traversed quad into `cuts + 1` quads, preserve connectivity, and select all generated loop edges. One cut uses `position` directly; multiple cuts are evenly spaced around it with interval `1 / (cuts + 1)` and must remain inside the edge. A loop reaching a boundary or unsupported face is rejected atomically. |
| Recalculate normals | One closed, orientable, manifold face component with no zero-area faces; scope is `connected-component`. If a mesh has multiple components, one selected face is required as the component seed. | Propagate consistent winding across shared edges, orient the closed component outward by signed volume, and preserve topology and selection. |
| Flip normals | One or more valid selected faces; scope is `selected-faces`. | Reverse selected face winding without changing connectivity; preserve the selection. |

## Explicit Limitations

- MVP mesh fixtures are polygon surfaces; this contract does not claim full Blender operator parity, arbitrary ngon triangulation behavior, self-intersection repair, or non-manifold repair.
- Face connectivity for component-scoped normal recalculation is determined through shared edges, not shared vertices. A mesh with multiple edge-disconnected face components needs a selected face to identify the component; open components are rejected because the outward direction is ambiguous.
- Extrusion with disconnected selected face islands is rejected as one atomic request in the first contract. This avoids an implicit per-island direction rule.
- Dissolve does not remove a boundary edge when `preserveBoundary` is true.
- Dissolve merges adjacent faces into a single polygon; it does not fill holes or guess how to preserve mixed materials. Face regions with mixed materials, ambiguous boundaries, or fewer than two faces are rejected.
- Bevel supports isolated edges whose endpoints have exactly three incident faces. Boundary/non-manifold edges, endpoint junctions, non-planar adjacent faces, and selected edges whose bevel regions overlap are outside the MVP eligible set.
- Loop cuts reject open-boundary termination, triangle/ngon traversal, and ambiguous branches.
- Normal recalculation does not guess an outward direction for open surfaces or repair non-orientable/non-manifold input.
- Numeric parameters must be finite and within geometry-dependent validity limits. A command must report a structured reason when the mesh-specific limit is exceeded.

## Generated Verification

`packages/model-core/src/mesh-operations.property.test.mjs` runs each implemented mesh command against twelve deterministic generated size/parameter seeds. Successful cases validate document invariants and command receipts, compare repeated executions for deterministic output, and verify exact one-step undo/redo snapshots. A companion rejection matrix exercises every mesh command plus a non-manifold dissolve input and asserts document and history atomicity. These generated cases broaden the fixed contract fixtures; they do not imply support for topology excluded above.

Changes to these contracts require updating the fixtures and operation API before algorithm implementation; they cannot be inferred later from renderer behavior.
