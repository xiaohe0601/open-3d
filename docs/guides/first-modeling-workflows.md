# First Modeling Workflows

These workflows use the browser workspace only. No account, AI provider, or API key is needed.

## Build a Simple Scene

1. Open **Add object** using the plus button beside **Objects**. On narrow screens, first open the **Objects** panel. The menu opens beneath the button without covering the workspace with a modal.
2. Choose **Box**, **Sphere**, or **Cylinder** to add a primitive to the current scene. Existing objects are kept; preset scenes are no longer offered.
3. Select an object in the **Objects** hierarchy. Its name and numeric transform fields appear in **Properties**. Shape icons distinguish primitive topology; edited meshes can use the generic mesh icon.
4. Rename it in the object name field and press Enter. Change Position, Rotation, or Scale values to place it precisely; leaving a field commits the value.
5. Add more primitives and repeat the transform step to compose the scene. Use the hierarchy eye button to hide or show an object, Copy to duplicate it, and Delete to remove it.
6. Use **Undo** in the top bar to reverse a committed action.

## Select Mesh Components

1. Choose **Add object** > **Box** and select the new object.
2. Choose **Face** in the viewport's component controls. Entering a component mode selects all components of that type.
3. To isolate one face, click an empty part of the viewport once to clear the initial selection, then click the face you want to edit. The selection status appears below the viewport.
4. Switch between **Object**, **Vertex**, **Edge**, and **Face** to change the selection mode. The properties panel currently exposes only the **Transform** group with Position, Rotation, and Scale fields. Selecting **Move**, **Rotate**, or **Scale** below the viewport enables canvas dragging without adding controls to the properties panel. Drag to preview, release to commit, or press Escape during a drag to cancel.
5. Use **Undo** to restore the document before the last committed operation.

The core command API and AI tools retain the polygon mesh-operation catalog, but its manual properties panel is not currently exposed in the workspace. AI use requires a separately configured provider. Unsupported topology is rejected explicitly; sculpting, animation, and full Blender parity are outside this MVP workflow.

## Align the View

Click **View** above the canvas to open a compact vertical menu of six directions, then choose a view to align the camera. Hovering does not open or close the menu. Orbit with the mouse to move away from the aligned view. Click the trigger again or outside the menu to close it. Keyboard users can press ArrowDown on the entry, navigate with arrows or Home/End, and press Enter to align or Escape to close.