import { create } from "zustand";
import { initializeI18n } from "./i18n";
import {
  initializeWorkspacePreferences,
  readWorkspacePreferences,
  type WorkspacePreferenceController,
  type WorkspacePreferences,
  type ResolvedWorkspacePreferences,
} from "./workspace-preferences";

interface WorkspaceUiState {
  notice: string;
  displayPreferences: WorkspacePreferences;
  resolvedPreferences: ResolvedWorkspacePreferences;
  preferenceController: WorkspacePreferenceController | null;
  setNotice: (notice: string) => void;
  setPreferenceController: (controller: WorkspacePreferenceController) => void;
  updateDisplayPreferences: (preferences: WorkspacePreferences) => void;
}

let unsubscribePreferences: (() => void) | undefined;

export const useWorkspaceUiStore = create<WorkspaceUiState>((set, get) => ({
  notice: "",
  displayPreferences: readWorkspacePreferences(),
  resolvedPreferences: { theme: "light", language: "en" },
  preferenceController: null,
  setNotice: (notice) => set({ notice }),
  setPreferenceController: (preferenceController) => {
    unsubscribePreferences?.();
    unsubscribePreferences = preferenceController.subscribe((resolved) => {
      set({ displayPreferences: preferenceController.preferences, resolvedPreferences: resolved });
      void initializeI18n(resolved.language);
    });
    set({
      preferenceController,
      displayPreferences: preferenceController.preferences,
      resolvedPreferences: preferenceController.resolved,
    });
    void initializeI18n(preferenceController.resolved.language);
  },
  updateDisplayPreferences: (preferences) => {
    let controller = get().preferenceController;
    if (!controller) {
      controller = initializeWorkspacePreferences(document.documentElement);
      get().setPreferenceController(controller);
    }
    controller.update(preferences);
  },
}));