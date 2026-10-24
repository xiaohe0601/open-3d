import { createRoot } from "react-dom/client";
import { WorkspaceApp } from "./app";
import { initializeWorkspacePreferences } from "./workspace-preferences";
import { useWorkspaceUiStore } from "./workspace-ui-store";
import { initializeI18n } from "./i18n";

const preferenceController = initializeWorkspacePreferences(document.documentElement);
useWorkspaceUiStore.getState().setPreferenceController(preferenceController);
void initializeI18n(preferenceController.resolved.language).then(() => {
  const mountPoint = document.getElementById("app");

  if (!mountPoint) {
    throw new Error("Missing #app mount point.");
  }

  createRoot(mountPoint).render(<WorkspaceApp projectRouting />);
});