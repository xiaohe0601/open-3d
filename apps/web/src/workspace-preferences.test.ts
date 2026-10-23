import { describe, expect, test } from "vite-plus/test";
import {
  readWorkspacePreferences,
  resolveWorkspacePreferences,
  subscribeToSystemPreferenceChanges,
  workspacePreferencesStorageKey,
  writeWorkspacePreferences,
  type PreferenceStorage,
  type SystemPreferenceSource,
  type WorkspacePreferences,
} from "./workspace-preferences";

class MemoryStorage {
  private values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

function systemSource() {
  let dark = false;
  let languages: readonly string[] = ["en-US"];
  const themeListeners = new Set<() => void>();
  const languageListeners = new Set<() => void>();
  const source: SystemPreferenceSource = {
    prefersDark: () => dark,
    languages: () => languages,
    subscribeTheme: (listener) => {
      themeListeners.add(listener);
      return () => themeListeners.delete(listener);
    },
    subscribeLanguage: (listener) => {
      languageListeners.add(listener);
      return () => languageListeners.delete(listener);
    },
  };

  return {
    source,
    setDark(value: boolean) {
      dark = value;
      themeListeners.forEach((listener) => listener());
    },
    setLanguages(value: readonly string[]) {
      languages = value;
      languageListeners.forEach((listener) => listener());
    },
  };
}

describe("workspace display preferences", () => {
  test("defaults to system preferences when storage is empty or unavailable", () => {
    expect(readWorkspacePreferences(new MemoryStorage())).toEqual({
      theme: "system",
      language: "system",
    });
    expect(readWorkspacePreferences(null)).toEqual({ theme: "system", language: "system" });
    expect(writeWorkspacePreferences({ theme: "dark", language: "zh-CN" }, null)).toBe(false);
  });

  test("ignores malformed and unsupported versioned records", () => {
    const storage = new MemoryStorage();
    storage.setItem(workspacePreferencesStorageKey, "{broken");
    expect(readWorkspacePreferences(storage)).toEqual({ theme: "system", language: "system" });

    storage.setItem(
      workspacePreferencesStorageKey,
      JSON.stringify({ version: 2, preferences: { theme: "dark", language: "zh-CN" } }),
    );
    expect(readWorkspacePreferences(storage)).toEqual({ theme: "system", language: "system" });
  });

  test("round-trips explicit choices in a versioned browser record", () => {
    const storage = new MemoryStorage();
    const preferences: WorkspacePreferences = { theme: "dark", language: "zh-CN" };
    expect(writeWorkspacePreferences(preferences, storage)).toBe(true);
    expect(JSON.parse(storage.getItem(workspacePreferencesStorageKey)!)).toEqual({
      version: 1,
      preferences,
    });
    expect(readWorkspacePreferences(storage)).toEqual(preferences);
  });

  test("falls back safely when browser storage throws", () => {
    const unavailableStorage: PreferenceStorage = {
      getItem() {
        throw new Error("Storage access denied.");
      },
      setItem() {
        throw new Error("Storage access denied.");
      },
    };

    expect(readWorkspacePreferences(unavailableStorage)).toEqual({ theme: "system", language: "system" });
    expect(writeWorkspacePreferences({ theme: "dark", language: "en" }, unavailableStorage)).toBe(false);
  });

  test("resolves supported Chinese locales and falls back to English", () => {
    const system = systemSource();
    expect(resolveWorkspacePreferences({ theme: "system", language: "system" }, system.source)).toEqual({
      theme: "light",
      language: "en",
    });
    system.setLanguages(["fr-FR", "zh-Hant"]);
    expect(resolveWorkspacePreferences({ theme: "system", language: "system" }, system.source).language).toBe("zh-CN");
    system.setLanguages(["zh"]);
    expect(resolveWorkspacePreferences({ theme: "system", language: "system" }, system.source).language).toBe("zh-CN");
    system.setLanguages(["en-GB", "zh-CN"]);
    expect(resolveWorkspacePreferences({ theme: "system", language: "system" }, system.source).language).toBe("en");
  });

  test("manual overrides win and system changes update only system preferences", () => {
    const system = systemSource();
    const observed: Array<{ theme: string; language: string }> = [];
    const unsubscribe = subscribeToSystemPreferenceChanges(
      { theme: "dark", language: "system" },
      system.source,
      (resolved) => observed.push(resolved),
    );

    system.setDark(true);
    expect(observed).toHaveLength(0);
    system.setLanguages(["zh-CN"]);
    expect(observed).toEqual([{ theme: "dark", language: "zh-CN" }]);
    unsubscribe();
    system.setLanguages(["en-US"]);
    expect(observed).toHaveLength(1);
  });

  test("resolves theme changes while following the system", () => {
    const system = systemSource();
    const observed: string[] = [];
    const unsubscribe = subscribeToSystemPreferenceChanges(
      { theme: "system", language: "en" },
      system.source,
      (resolved) => observed.push(resolved.theme),
    );

    system.setDark(true);
    expect(observed).toEqual(["dark"]);
    unsubscribe();
  });
});