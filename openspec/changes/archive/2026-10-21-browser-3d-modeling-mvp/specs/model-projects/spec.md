# Spec Delta

## Purpose

Lets users save, recover, and exchange supported modeling work locally through a versioned native project format and bounded glTF interchange.

## ADDED Requirements

### Requirement: Native projects preserve supported editable state
The system SHALL define a versioned native project format that preserves supported scene hierarchy, object transforms, editable mesh topology, supported material properties, and relevant workspace view settings.

#### Scenario: Save and reopen a native project
- **WHEN** a user saves a valid project and later reopens it
- **THEN** the system restores supported hierarchy, geometry, transforms, materials, and workspace view settings

#### Scenario: Open a project with a newer unsupported version
- **WHEN** a user opens a native project whose version is newer than the application supports
- **THEN** the system refuses unsafe interpretation, explains the compatibility issue, and does not overwrite the source

### Requirement: Users can recover browser-local projects
The system SHALL provide a local project list and persist saved projects in browser storage without requiring an account or remote service.

#### Scenario: Recover a saved project after reload
- **WHEN** a user reloads the application after saving a project locally
- **THEN** the project appears in the local project list and can be reopened

#### Scenario: Protect unsaved work when leaving a project
- **WHEN** a user attempts to close or replace a project with uncommitted changes
- **THEN** the system offers a save, discard, or cancel choice

#### Scenario: Browser storage is unavailable or exhausted
- **WHEN** browser storage is denied, unavailable, or has insufficient quota
- **THEN** the system explains the condition and offers portable native export when possible

### Requirement: Users can transfer portable native projects
The system SHALL let users export and import a portable native project file independently of browser-local storage.

#### Scenario: Export a native project
- **WHEN** a user exports the current project
- **THEN** the system produces a portable file that can be reopened with the supported editable state intact

#### Scenario: Import a malformed native project
- **WHEN** a user imports a malformed or unsupported native file
- **THEN** the system reports the problem and leaves the active project unchanged

### Requirement: Users can import and export the initial glTF subset
The system SHALL support GLB and glTF import/export for mesh geometry, scene hierarchy, object transforms, and base-color and metallic-roughness material factors.

#### Scenario: Import supported GLB or glTF content
- **WHEN** a user imports a valid supported GLB or glTF file
- **THEN** the system creates editable scene content for supported meshes and reports unsupported content that is not preserved

#### Scenario: Export supported GLB or glTF content
- **WHEN** a user exports a scene to GLB or glTF
- **THEN** the system writes supported mesh geometry, hierarchy, transforms, and material factors in the selected format

#### Scenario: Import or export unsupported content
- **WHEN** a file contains or the scene includes unsupported extensions, textures, animation, lights, cameras, or other unsupported data
- **THEN** the system identifies content that is omitted or cannot be edited before or after completing the operation

#### Scenario: Interchange operation fails
- **WHEN** an import or export fails validation or serialization
- **THEN** the system reports the error and does not partially replace the active project
