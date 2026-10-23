export type ThemePreference = "system" | "light" | "dark";
export type LanguagePreference = "system" | "en" | "zh-CN";
export type ResolvedTheme = Exclude<ThemePreference, "system">;
export type ResolvedLanguage = Exclude<LanguagePreference, "system">;

export interface WorkspacePreferences {
  theme: ThemePreference;
  language: LanguagePreference;
}

export interface ResolvedWorkspacePreferences {
  theme: ResolvedTheme;
  language: ResolvedLanguage;
}

export interface SystemPreferenceSource {
  prefersDark: () => boolean;
  languages: () => readonly string[];
  subscribeTheme: (listener: () => void) => () => void;
  subscribeLanguage: (listener: () => void) => () => void;
}

export interface WorkspacePreferenceController {
  preferences: WorkspacePreferences;
  resolved: ResolvedWorkspacePreferences;
  update: (preferences: WorkspacePreferences) => boolean;
  subscribe: (listener: (resolved: ResolvedWorkspacePreferences) => void) => () => void;
  unsubscribe: () => void;
}

export interface PreferenceStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

const STORAGE_KEY = "open-3d:workspace-preferences";
const STORAGE_VERSION = 1;
const DEFAULT_PREFERENCES: WorkspacePreferences = {
  theme: "system",
  language: "system",
};

function isThemePreference(value: unknown): value is ThemePreference {
  return value === "system" || value === "light" || value === "dark";
}

function isLanguagePreference(value: unknown): value is LanguagePreference {
  return value === "system" || value === "en" || value === "zh-CN";
}

function getBrowserStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readWorkspacePreferences(
  storage: PreferenceStorage | null = getBrowserStorage(),
): WorkspacePreferences {
  if (!storage) return { ...DEFAULT_PREFERENCES };

  try {
    const value: unknown = JSON.parse(storage.getItem(STORAGE_KEY) ?? "null");
    if (typeof value !== "object" || value === null) return { ...DEFAULT_PREFERENCES };

    const record = value as Record<string, unknown>;
    if (record.version !== STORAGE_VERSION || typeof record.preferences !== "object" || record.preferences === null) {
      return { ...DEFAULT_PREFERENCES };
    }

    const preferences = record.preferences as Record<string, unknown>;
    return {
      theme: isThemePreference(preferences.theme) ? preferences.theme : "system",
      language: isLanguagePreference(preferences.language) ? preferences.language : "system",
    };
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

export function writeWorkspacePreferences(
  preferences: WorkspacePreferences,
  storage: PreferenceStorage | null = getBrowserStorage(),
): boolean {
  if (!storage) return false;

  try {
    storage.setItem(STORAGE_KEY, JSON.stringify({ version: STORAGE_VERSION, preferences }));
    return true;
  } catch {
    return false;
  }
}

export function resolveWorkspacePreferences(
  preferences: WorkspacePreferences,
  source: Pick<SystemPreferenceSource, "prefersDark" | "languages">,
): ResolvedWorkspacePreferences {
  const preferredLanguage = source.languages().find((language) => /^(?:en|zh)(?:-|$)/i.test(language));
  const systemLanguage = preferredLanguage && /^zh(?:-|$)/i.test(preferredLanguage) ? "zh-CN" : "en";

  return {
    theme: preferences.theme === "system" ? (source.prefersDark() ? "dark" : "light") : preferences.theme,
    language: preferences.language === "system" ? systemLanguage : preferences.language,
  };
}

export function createBrowserSystemPreferenceSource(): SystemPreferenceSource | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;

  const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
  return {
    prefersDark: () => mediaQuery.matches,
    languages: () => (navigator.languages?.length ? navigator.languages : [navigator.language]),
    subscribeTheme: (listener) => {
      mediaQuery.addEventListener("change", listener);
      return () => mediaQuery.removeEventListener("change", listener);
    },
    subscribeLanguage: (listener) => {
      window.addEventListener("languagechange", listener);
      return () => window.removeEventListener("languagechange", listener);
    },
  };
}

export function subscribeToSystemPreferenceChanges(
  preferences: WorkspacePreferences,
  source: SystemPreferenceSource,
  onChange: (resolved: ResolvedWorkspacePreferences) => void,
): () => void {
  const unsubscribers: Array<() => void> = [];
  const update = () => onChange(resolveWorkspacePreferences(preferences, source));

  if (preferences.theme === "system") unsubscribers.push(source.subscribeTheme(update));
  if (preferences.language === "system") unsubscribers.push(source.subscribeLanguage(update));

  return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
}

export function applyResolvedWorkspacePreferences(
  documentElement: HTMLElement,
  resolved: ResolvedWorkspacePreferences,
): void {
  documentElement.dataset.theme = resolved.theme;
  documentElement.classList.toggle("dark", resolved.theme === "dark");
  documentElement.style.colorScheme = resolved.theme;
  documentElement.lang = resolved.language;
}

export function initializeWorkspacePreferences(
  documentElement: HTMLElement,
  storage: PreferenceStorage | null = getBrowserStorage(),
  source: SystemPreferenceSource | null = createBrowserSystemPreferenceSource(),
): WorkspacePreferenceController {
  let preferences = readWorkspacePreferences(storage);
  const fallbackSource: Pick<SystemPreferenceSource, "prefersDark" | "languages"> = source ?? {
    prefersDark: () => false,
    languages: () => (typeof navigator === "undefined" ? [] : navigator.languages),
  };
  let resolved = resolveWorkspacePreferences(preferences, fallbackSource);
  const listeners = new Set<(resolved: ResolvedWorkspacePreferences) => void>();
  let unsubscribeSystem = () => {};
  const apply = () => {
    resolved = resolveWorkspacePreferences(preferences, fallbackSource);
    applyResolvedWorkspacePreferences(documentElement, resolved);
    listeners.forEach((listener) => listener(resolved));
  };
  const subscribe = () => {
    unsubscribeSystem();
    unsubscribeSystem = source ? subscribeToSystemPreferenceChanges(preferences, source, () => apply()) : () => {};
  };

  apply();
  subscribe();

  return {
    get preferences() {
      return preferences;
    },
    get resolved() {
      return resolved;
    },
    update(nextPreferences) {
      const saved = writeWorkspacePreferences(nextPreferences, storage);
      preferences = nextPreferences;
      apply();
      subscribe();
      return saved;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    unsubscribe() {
      unsubscribeSystem();
      listeners.clear();
    },
  };
}

export const workspacePreferencesStorageKey = STORAGE_KEY;