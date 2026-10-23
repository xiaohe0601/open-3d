export const topologyContracts = [
  {
    operation: "extrude.vertices",
    parameters: { distance: 1, direction: [0, 0, 1] },
    eligibility:
      "Exactly one existing vertex and a non-zero direction are required; duplicate the vertex at normalized direction times distance and connect it to the source with one edge.",
    cases: [
      {
        id: "single-vertex",
        input: "single-quad-selected-vertex",
        accepted: true,
        expected: { vertexDelta: 1, edgeDelta: 1, selected: "extruded-edge" },
      },
      {
        id: "multiple-vertices",
        input: "single-quad-multiple-selected-vertices",
        accepted: false,
        reason: "selection-too-large",
      },
      {
        id: "zero-direction",
        input: "single-quad-zero-extrusion-direction",
        accepted: false,
        reason: "zero-direction",
      },
    ],
  },
  {
    operation: "extrude.edges",
    parameters: { distance: 1, direction: [0, 0, 1] },
    eligibility:
      "Selected edges must form one open, connected, non-branching chain of boundary edges, each incident to exactly one face; translate a duplicate chain and bridge it with quads.",
    cases: [
      {
        id: "single-boundary-edge",
        input: "single-quad-selected-boundary-edge",
        accepted: true,
        expected: { vertexDelta: 2, edgeDelta: 3, faceDelta: 1, selected: "extruded-face" },
      },
      {
        id: "branched-boundary-edges",
        input: "boundary-edge-branch",
        accepted: false,
        reason: "branched-selection",
      },
      {
        id: "closed-boundary-loop",
        input: "closed-boundary-edge-loop",
        accepted: false,
        reason: "closed-selection",
      },
      {
        id: "interior-edge",
        input: "interior-manifold-edge",
        accepted: false,
        reason: "not-boundary-edge",
      },
    ],
  },
  {
    operation: "extrude.faces",
    parameters: { distance: 1 },
    eligibility:
      "Selected faces form one connected region on a manifold surface; region boundary edges have one selected and one unselected incident face.",
    cases: [
      {
        id: "single-quad",
        input: "single-quad",
        accepted: true,
        expected: { vertices: 8, edges: 12, faces: 6, selected: "cap-face" },
      },
      {
        id: "disconnected-face-islands",
        input: "two-disconnected-quads",
        accepted: false,
        reason: "disconnected-selection",
      },
      {
        id: "non-manifold-region",
        input: "three-faces-on-one-non-manifold-edge",
        accepted: false,
        reason: "non-manifold-edge",
      },
    ],
  },
  {
    operation: "inset.faces",
    parameters: { offset: 0.1 },
    eligibility: "Selected faces form one connected, planar region with a simple boundary and positive-area faces.",
    cases: [
      {
        id: "single-quad",
        input: "single-quad",
        accepted: true,
        expected: { vertices: 8, edges: 12, faces: 5, selected: "inner-face" },
      },
      {
        id: "boundary-crossing-offset",
        input: "quad-offset-exceeds-inradius",
        accepted: false,
        reason: "inset-collapses-face",
      },
      {
        id: "degenerate-face",
        input: "zero-area-quad",
        accepted: false,
        reason: "degenerate-face",
      },
    ],
  },
  {
    operation: "merge.vertices",
    parameters: { target: "center" },
    eligibility:
      "At least two distinct vertices are selected; target is center or last-selected; resulting incident faces remain non-degenerate.",
    cases: [
      {
        id: "adjacent-quad-corners",
        input: "single-quad-adjacent-vertices",
        accepted: true,
        expected: { vertexDelta: -1, collapsedEdgesRemoved: 1, faceDelta: 0, selected: "merged-vertex" },
      },
      {
        id: "disconnected-islands",
        input: "two-disconnected-quads",
        accepted: true,
        expected: { vertexDelta: -1, degenerateFacesRemoved: 0, selected: "merged-vertex" },
      },
      {
        id: "fewer-than-two-vertices",
        input: "single-selected-vertex",
        accepted: false,
        reason: "selection-too-small",
      },
    ],
  },
  {
    operation: "dissolve.edges",
    parameters: { preserveBoundary: true },
    eligibility:
      "Selected edges are interior manifold edges; their incident faces can be merged into simple non-degenerate polygons.",
    cases: [
      {
        id: "coplanar-quad-diagonal",
        input: "triangulated-quad",
        accepted: true,
        expected: { edgeDelta: -1, faceDelta: -1, selected: "merged-face" },
      },
      {
        id: "boundary-edge",
        input: "single-quad-boundary-edge",
        accepted: false,
        reason: "boundary-edge",
      },
      {
        id: "non-manifold-edge",
        input: "three-faces-on-one-non-manifold-edge",
        accepted: false,
        reason: "non-manifold-edge",
      },
      {
        id: "unselected-internal-edge",
        input: "three-faces-two-selected-edges",
        accepted: false,
        reason: "unselected-internal-edge",
      },
    ],
  },
  {
    operation: "dissolve.faces",
    parameters: { faceIds: ["face-1", "face-2"] },
    eligibility:
      "Each selected connected face region has at least two faces, one simple non-degenerate boundary, and a shared material.",
    cases: [
      {
        id: "selected-triangle-pair",
        input: "triangulated-quad-selected-faces",
        accepted: true,
        expected: { faceDelta: -1, edgeDelta: -1, selected: "merged-face" },
      },
      {
        id: "single-face",
        input: "single-quad",
        accepted: false,
        reason: "selection-too-small",
      },
      {
        id: "disconnected-regions",
        input: "two-disconnected-quads-selected",
        accepted: false,
        reason: "selection-too-small",
      },
      {
        id: "mixed-material-region",
        input: "triangulated-quad-mixed-materials",
        accepted: false,
        reason: "mixed-materials",
      },
    ],
  },
  {
    operation: "bevel.edges",
    parameters: { width: 0.1, segments: 1 },
    eligibility:
      "Selected edges have two planar incident faces, exactly three incident faces at each endpoint, and a width shorter than adjacent edges; selected bevel regions cannot overlap.",
    cases: [
      {
        id: "cube-edge",
        input: "cube",
        accepted: true,
        expected: { segments: 1, newFaces: 1, selected: "bevel-faces" },
      },
      {
        id: "boundary-edge",
        input: "single-quad-boundary-edge",
        accepted: false,
        reason: "boundary-edge",
      },
      {
        id: "width-collapses-face",
        input: "cube-edge-width-exceeds-limit",
        accepted: false,
        reason: "bevel-collapses-face",
      },
      {
        id: "competing-bevel-edges",
        input: "cube-adjacent-selected-edges",
        accepted: false,
        reason: "bevel-junction",
      },
    ],
  },
  {
    operation: "loopCut.quads",
    parameters: { cuts: 1, position: 0.5 },
    eligibility:
      "The seed traverses one closed, unbranched loop through non-degenerate quads; normalized center position is strictly between zero and one and all evenly spaced cuts stay inside each edge.",
    cases: [
      {
        id: "closed-cube-loop",
        input: "cube",
        accepted: true,
        expected: { cuts: 1, selected: "new-loop-edges" },
      },
      {
        id: "loop-reaches-boundary",
        input: "open-quad-strip",
        accepted: false,
        reason: "loop-reaches-boundary",
      },
      {
        id: "loop-reaches-triangle",
        input: "quad-loop-with-triangle",
        accepted: false,
        reason: "non-quad-face",
      },
      {
        id: "cut-crosses-edge-end",
        input: "closed-quad-loop-cut-position-out-of-range",
        accepted: false,
        reason: "loop-cut-out-of-range",
      },
    ],
  },
  {
    operation: "normals.recalculate",
    parameters: { scope: "connected-component" },
    eligibility:
      "The selected connected component is closed, orientable, manifold, and contains no zero-area faces; consistent winding is oriented outward by signed volume. A seed face is required when the mesh has multiple disconnected components.",
    cases: [
      {
        id: "closed-cube",
        input: "cube",
        accepted: true,
        expected: { normals: "consistent-outward", selected: "unchanged" },
      },
      {
        id: "inconsistent-face-winding",
        input: "cube-with-one-reversed-face",
        accepted: true,
        expected: { normals: "consistent-outward", selected: "unchanged" },
      },
      {
        id: "open-component",
        input: "single-quad",
        accepted: false,
        reason: "boundary-edge",
      },
      {
        id: "ambiguous-disconnected-components",
        input: "two-disconnected-cubes-without-face-selection",
        accepted: false,
        reason: "ambiguous-component",
      },
      {
        id: "non-manifold-component",
        input: "three-faces-on-one-non-manifold-edge",
        accepted: false,
        reason: "non-manifold-edge",
      },
      {
        id: "degenerate-face",
        input: "zero-area-quad",
        accepted: false,
        reason: "degenerate-face",
      },
    ],
  },
  {
    operation: "normals.flip",
    parameters: { scope: "selected-faces" },
    eligibility: "At least one valid face is selected; connectivity is unchanged.",
    cases: [
      {
        id: "single-face",
        input: "single-quad",
        accepted: true,
        expected: { normalDirection: "reversed", topologyDelta: 0, selected: "unchanged" },
      },
      {
        id: "empty-selection",
        input: "single-quad",
        accepted: false,
        reason: "selection-empty",
      },
      {
        id: "degenerate-face",
        input: "zero-area-quad",
        accepted: false,
        reason: "degenerate-face",
      },
    ],
  },
];

export const requiredInputClasses = ["boundary", "disconnected", "non-manifold", "degenerate"];