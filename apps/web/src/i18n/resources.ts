import { common } from "./common";
import { workspace } from "./workspace";
import { modeling } from "./modeling";
import { projects } from "./projects";
import { ai } from "./ai";
import { creation } from "./creation";

export const resources = {
  en: {
    common: common["en"],
    workspace: workspace["en"],
    modeling: modeling["en"],
    projects: projects["en"],
    ai: ai["en"],
    creation: creation["en"],
  },
  "zh-CN": {
    common: common["zh-CN"],
    workspace: workspace["zh-CN"],
    modeling: modeling["zh-CN"],
    projects: projects["zh-CN"],
    ai: ai["zh-CN"],
    creation: creation["zh-CN"],
  },
} as const;

export type AppLocale = keyof typeof resources;
export type AppNamespace = keyof (typeof resources)["en"];