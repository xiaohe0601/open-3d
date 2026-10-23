# Project File Formats

Use a native `.open3d` file when you need to preserve an editable project for this application. Use GLB or glTF to exchange supported scene content with other 3D tools. GLB/glTF files are not native project backups.

## Native `.open3d` Projects

The portable native format stores the versioned modeling document, including scene and object hierarchy, transforms, editable polygon mesh topology, supported material factors, object visibility, selection, and workspace view settings. The application migrates supported older project versions when opening them. It rejects malformed projects, invalid documents, and newer unsupported versions rather than replacing the current project.

Browser-local projects are a separate convenience copy stored by this browser on this device. They are not a backup guarantee. Export a portable `.open3d` file when you need a user-controlled copy.

## Project Controls

- Click the project name beside Open 3D to edit it inline. Confirm a valid name with Enter or by leaving the field, or cancel with Escape. An empty name cannot be committed; leaving an empty field cancels the edit. The change supports Undo and Redo; use Save to persist it.
- Open **Projects** to search browser saves and open a project. A highlighted row background identifies the current project, without an extra badge or label. The list updates when opened, after project actions, and when you return to the app. Each row's action menu offers Rename, Duplicate, and Delete. Renaming here updates the saved name immediately; duplicating copies the last saved version, not any unsaved edits in the workspace.
- Rename and Delete open independent dialogs; cancel or press Escape to return to the project list. Delete removes only the browser save. If that project is open, the working scene and its unsaved edits remain in the workspace. Save again to create a new local save.
- Automatic refresh retains the existing project list and search while loading; no manual refresh is needed. A failed refresh reports the error without removing the previously loaded projects.
- **Import** and **Export** are independent toolbar actions, not part of the project list. Import accepts native projects, GLB, or glTF (including accompanying resource files). Export offers open3d, GLB, and glTF side by side, with format guidance below. Importing a different scene still prompts before replacing unsaved work.
- Storage and file errors leave the active scene available. If browser storage is blocked or full, close the project list and use Export to keep a portable copy.

## GLB and glTF Interchange

The current interchange adapter imports and exports:

- The selected/default scene, its node hierarchy, and node transforms.
- Mesh triangle geometry. Polygon faces are triangulated during export; imported supported triangle, triangle-strip, and triangle-fan primitives become editable triangle faces.
- Material base-color, metallic, and roughness factors.

GLB/glTF does not preserve native editor state such as selection or workspace camera, projection, grid, and axes settings. Imported projects receive default workspace view settings. Object visibility is not preserved on export; hidden objects are exported as visible and this loss is reported.

The adapter does not preserve textures, animation, cameras, skins, morph targets, arbitrary glTF extensions, or additional non-default scenes. It reports unsupported content it detects, but that report is not a guarantee that every unsupported field or extension in every input file is identified. Review import/export notices and keep the original file when unsupported content matters.

## Choosing a Format

| Need                                                                 | Format                                                             |
| -------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Continue editing this application's project, including editor state  | `.open3d`                                                          |
| Exchange supported mesh, hierarchy, transforms, and material factors | `.glb` or `.gltf`                                                  |
| Preserve unsupported extensions or content losslessly                | Keep the source file; this adapter does not provide that guarantee |

Neither format is a substitute for keeping independent backups of important work.