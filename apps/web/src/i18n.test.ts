import { afterEach, describe, expect, test } from "vite-plus/test";
import i18n, { initializeI18n, resources } from "./i18n";
import { describeModelingError, meshOperationLabelKeys } from "./workspace/localization";

afterEach(async () => {
  if (i18n.isInitialized) await i18n.changeLanguage("en");
});

describe("workspace translations", () => {
  test("punctuates explanatory sentences but not short labels or statuses", () => {
    for (const copy of Object.values(resources)) {
      for (const sentence of [
        copy.ai.credentialNotice,
        copy.projects.transferDescription,
        copy.projects.deleteDescription,
      ]) {
        expect(sentence).toMatch(/[.。]$/);
      }
      for (const label of [
        copy.ai.saveSettings,
        copy.ai.complete,
        copy.ai.cancelled,
        copy.workspace.projectLabel,
        copy.projects.rename,
        copy.projects.downloaded,
      ]) {
        expect(label).not.toMatch(/[.。]$/);
      }
    }
  });

  test("both locales cover exactly the same feature keys", () => {
    function keys(value: unknown, prefix = ""): string[] {
      if (typeof value !== "object" || value === null) return [prefix];
      return Object.entries(value)
        .flatMap(([key, child]) => keys(child, `${prefix}.${key}`))
        .sort();
    }
    expect(keys(resources["zh-CN"])).toEqual(keys(resources.en));
  });

  test("both locales preserve the same interpolation variables", () => {
    function entries(value: object, prefix = ""): [string, string][] {
      return Object.entries(value).flatMap(([key, child]) =>
        typeof child === "string" ? [[`${prefix}${key}`, child]] : entries(child, `${prefix}${key}.`),
      );
    }
    const chinese = new Map(entries(resources["zh-CN"]));
    const variables = (text: string) => [...text.matchAll(/{{\s*([^}]+?)\s*}}/g)].map((match) => match[1]).sort();
    for (const [key, text] of entries(resources.en)) {
      expect(text.trim(), key).not.toBe("");
      expect(chinese.get(key)?.trim(), key).not.toBe("");
      expect(variables(chinese.get(key)!), key).toEqual(variables(text));
    }
  });

  test("keeps dynamically referenced mesh operation labels in both locales", () => {
    for (const copy of Object.values(resources)) {
      expect(
        Object.keys(copy.modeling.operations)
          .map((key) => `operations.${key}`)
          .sort(),
      ).toEqual(Object.values(meshOperationLabelKeys).sort());
    }
  });

  test.each(["en", "zh-CN"] as const)(
    "localizes mesh feedback without translating command IDs in %s",
    async (language) => {
      await initializeI18n(language);
      expect(i18n.t(meshOperationLabelKeys["mesh.extrude"], { ns: "modeling" })).toBe(
        language === "en" ? "Extrude" : "挤出",
      );
      expect(describeModelingError("zero-distance")).toBe(
        language === "en" ? "Extrusion distance must be non-zero" : "挤出距离不能为零",
      );
      expect(describeModelingError("future-error")).toBe(describeModelingError("execution-failed"));
      expect(Object.keys(meshOperationLabelKeys)).toContain("mesh.extrude");
    },
  );
  test("loads typed English and Simplified Chinese feature namespaces", async () => {
    await initializeI18n("en");
    expect(i18n.t("displayPreferences", { ns: "workspace" })).toBe("Display preferences");
    await i18n.changeLanguage("zh-CN");
    expect(i18n.t("displayPreferences", { ns: "workspace" })).toBe("显示偏好");
    expect(i18n.t("title", { ns: "creation" })).toBe("添加物体");
  });

  test.each(["en", "zh-CN"] as const)("keeps language names native in %s", async (language) => {
    await initializeI18n(language);
    expect(i18n.t("english", { ns: "common" })).toBe("English");
    expect(i18n.t("simplifiedChinese", { ns: "common" })).toBe("简体中文");
  });

  test("falls back to English when a Simplified Chinese key is missing", async () => {
    await initializeI18n("zh-CN");
    const original = i18n.getResourceBundle("zh-CN", "common");
    i18n.removeResourceBundle("zh-CN", "common");
    try {
      expect(i18n.t("save", { ns: "common" })).toBe("Save");
    } finally {
      i18n.addResourceBundle("zh-CN", "common", original);
    }
  });
});
describe("localized catalog and project feedback", () => {
  test.each(["en", "zh-CN"] as const)("presents safe project and command feedback in %s", async (language) => {
    const { commandLabel, describeProjectFailure, describeOmittedContent } = await import("./workspace/localization");
    const { MODELING_COMMANDS } = await import("@open-3d/model-core");
    const { NativeProjectError, LocalProjectStorageError } = await import("@open-3d/projects");
    await initializeI18n(language);
    for (const command of MODELING_COMMANDS) expect(commandLabel(command.id)).not.toBe(command.id);
    const cause = new LocalProjectStorageError("quota", "untrusted provider text");
    expect(describeProjectFailure({ kind: "storage", cause })).not.toContain(cause.message);
    expect(
      describeProjectFailure({ kind: "import", cause: new NativeProjectError("malformed-json", "raw error") }),
    ).not.toContain("raw error");
    expect(describeOmittedContent(["1 camera(s) were omitted."])).toBe(
      language === "en" ? "1 camera(s) were omitted" : "已忽略 1 项相机",
    );
  });
});