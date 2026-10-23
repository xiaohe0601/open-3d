# Spec Delta

## Purpose

Provides a desktop browser workspace for composing simple scenes and performing precise, predictable polygon-mesh edits with approachable defaults and professional controls.

## ADDED Requirements

### Requirement: Users can create and organize scene objects
The system SHALL let users create supported primitives and manage objects through the scene hierarchy.

#### Scenario: Create a primitive
- **WHEN** a user creates a supported primitive
- **THEN** the system adds it to the active scene, assigns a stable identity, and selects it

#### Scenario: Manage an object
- **WHEN** a user renames, duplicates, hides, unhides, or deletes an object
- **THEN** the hierarchy and viewport reflect the change and the active selection remains valid

### Requirement: Users can navigate the viewport
The system SHALL provide desktop pointer and keyboard controls for viewport navigation and standard view selection.

#### Scenario: Navigate without editing
- **WHEN** a user orbits, pans, or zooms the viewport
- **THEN** only the view state changes and scene geometry and transforms remain unchanged

#### Scenario: Choose a projection or standard view
- **WHEN** a user selects perspective, orthographic, or a standard axis view
- **THEN** the same scene is shown using the requested projection and orientation

### Requirement: Users can transform objects
The system SHALL support interactive and numeric translation, rotation, and scaling of selected objects, including axis constraints and configured snapping.

#### Scenario: Commit a numeric transform
- **WHEN** a user enters valid transform values and commits them
- **THEN** the object receives those values and the displayed properties match the document state

#### Scenario: Cancel a transform preview
- **WHEN** a user cancels an in-progress transform
- **THEN** the object returns to its pre-operation transform and no edit is added to history

### Requirement: Users can select mesh components
The system SHALL provide vertex, edge, and face selection modes for editable polygon meshes.

#### Scenario: Select components
- **WHEN** a user selects visible components in the active mode
- **THEN** the selection contains only valid component identities for that mesh and is available to modeling commands and queries

#### Scenario: Change selection mode
- **WHEN** a user switches component selection mode
- **THEN** conversion preserves the active mesh object, selects all target-mode components when entering component mode from object mode, maps between component modes by mesh incidence (vertices to incident edges/faces, edges to endpoints/incident faces, faces to vertices/boundary edges), and maps component mode to its owning object; clearing removes selected components while retaining the active mesh owner, and no result references nonexistent components

### Requirement: Users can transform selected mesh components
The system SHALL support interactive and numeric translation, rotation, and scaling of the current component selection.

#### Scenario: Transform selected components
- **WHEN** a user commits a valid component transform
- **THEN** the selected geometry changes, topology connectivity remains unchanged, and one undoable edit is recorded

### Requirement: Users can extrude selected mesh components
The system SHALL support extrusion of selected face regions and eligible edge or vertex selections using an explicit distance and a deterministic direction. Vertex extrusion SHALL accept one vertex and create a connecting edge. Edge extrusion SHALL accept one open, connected, non-branching chain of boundary edges and bridge it with faces. Extrusion direction SHALL be normalized before applying distance.

#### Scenario: Extrude a face region
- **WHEN** a user extrudes a valid face region by a distance
- **THEN** the system creates connected side faces and cap faces, selects the resulting region, and records one undoable edit

#### Scenario: Reject an ineligible extrusion
- **WHEN** an extrusion selection cannot produce a valid result under the supported topology rules
- **THEN** the system reports the eligibility reason and leaves geometry and history unchanged

### Requirement: Users can inset selected faces
The system SHALL support inset of an eligible connected face region using an explicit offset distance.

#### Scenario: Inset a face region
- **WHEN** a user insets an eligible face region by a valid distance
- **THEN** the system creates an inner face region and surrounding boundary faces and selects the resulting inner region

#### Scenario: Reject an invalid inset
- **WHEN** the requested inset distance or selected region would create invalid or degenerate topology
- **THEN** the system rejects the operation without mutating the mesh and explains the reason

### Requirement: Users can merge or dissolve mesh components
The system SHALL support deterministic merging of selected vertices and dissolution of eligible interior edges or connected face regions while preserving valid remaining topology. Dissolve SHALL merge affected faces into simple, non-degenerate polygons and SHALL reject regions with mixed materials or ambiguous boundaries.

#### Scenario: Merge selected vertices
- **WHEN** a user merges two or more selected vertices using the chosen merge target or center
- **THEN** the system creates one resulting vertex, rewires incident topology, removes degenerate elements, and selects the result

#### Scenario: Dissolve eligible components
- **WHEN** a user dissolves eligible selected edges or faces
- **THEN** the system removes selected internal edges and merges each affected connected face region into one polygon while retaining its outer boundary and selecting the result

#### Scenario: Reject an ineligible dissolve
- **WHEN** selected components include a boundary or non-manifold edge, a region with an ambiguous or degenerate boundary, or faces with mixed materials
- **THEN** the system rejects the dissolve without changing geometry, selection, or undo history and reports the eligibility reason

### Requirement: Users can bevel eligible mesh edges
The system SHALL bevel selected isolated manifold edges using an explicit width and segment count bounded by topology validity. Eligible edges SHALL have two planar incident faces and endpoints with exactly three incident faces; selected bevel regions SHALL NOT overlap.

#### Scenario: Bevel eligible edges
- **WHEN** a user bevels eligible selected edges with valid width and segment parameters
- **THEN** the system creates the corresponding chamfer geometry deterministically and selects the result

#### Scenario: Reject an ineligible bevel
- **WHEN** the selection or parameters cannot produce a valid bevel
- **THEN** the system reports the unsupported condition and leaves the mesh and history unchanged

### Requirement: Users can apply a loop cut to eligible quad topology
The system SHALL support a loop cut along an eligible closed, unbranched quad edge loop with an explicit cut count and normalized center position in `(0, 1)`. Multiple cuts SHALL be evenly spaced around the requested position and remain inside every traversed edge.

#### Scenario: Cut an eligible quad loop
- **WHEN** a user applies a loop cut to a supported continuous quad loop
- **THEN** the system inserts the requested cuts, preserves valid face connectivity, and selects the new components

#### Scenario: Reject a loop cut across unsupported topology
- **WHEN** the requested loop reaches a boundary, non-quad face, or ambiguous branch outside the supported rules
- **THEN** the system reports where the loop is unsupported and leaves the mesh unchanged

### Requirement: Users can correct mesh normals
The system SHALL support recalculating face normals and flipping selected face normals.

#### Scenario: Recalculate or flip normals
- **WHEN** a user runs a supported normal operation
- **THEN** the document normal state is updated and the viewport reflects the result

### Requirement: Invalid or cancelled operations do not corrupt the scene
The system SHALL validate an operation before commit and apply each committed operation atomically.

#### Scenario: Reject invalid parameters or selection
- **WHEN** a modeling operation receives invalid parameters or an ineligible selection
- **THEN** the system leaves the document and undo history unchanged and provides an actionable reason

#### Scenario: Cancel an interactive operation
- **WHEN** a user cancels a preview before commit
- **THEN** the system restores the exact pre-operation document state and does not add an undo entry
