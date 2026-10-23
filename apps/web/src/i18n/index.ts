import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { resources, type AppLocale } from "./resources";

export { resources };
export type { AppLocale, AppNamespace } from "./resources";

export function initializeI18n(language: AppLocale = "en") {
  if (i18n.isInitialized) {
    return i18n.changeLanguage(language);
  }

  return i18n.use(initReactI18next).init({
    resources,
    lng: language,
    fallbackLng: "en",
    supportedLngs: ["en", "zh-CN"],
    defaultNS: "common",
    ns: ["common", "workspace", "modeling", "projects", "ai", "creation"],
    interpolation: { escapeValue: false },
    returnNull: false,
  });
}

export default i18n;