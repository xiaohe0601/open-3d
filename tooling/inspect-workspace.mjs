import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const skillDirectory = process.env.TASTE_SKILL_DIR;
if (!skillDirectory) throw new Error("Set TASTE_SKILL_DIR to the installed design-taste-frontend skill directory.");

const preferences = {
  theme: process.env.WORKSPACE_THEME ?? "light",
  language: process.env.WORKSPACE_LANGUAGE ?? "en",
};
if (!["light", "dark"].includes(preferences.theme) || !["en", "zh-CN"].includes(preferences.language)) {
  throw new Error("Use WORKSPACE_THEME=light|dark and WORKSPACE_LANGUAGE=en|zh-CN.");
}

const { Browser, Page } = await import(pathToFileURL(resolve(skillDirectory, "scripts/lib/cdp.mjs")).href);
const newPage = Browser.prototype.newPage;
Browser.prototype.newPage = async function (...args) {
  const page = await newPage.apply(this, args);
  // Set real browser preferences before startup; leave the inspector and its measurements unchanged.
  await page.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `try { localStorage.setItem("open-3d:workspace-preferences", ${JSON.stringify(JSON.stringify({ version: 1, preferences }))}); } catch {}`,
  });
  return page;
};

const inspectObjects = process.env.WORKSPACE_VIEW === "objects";
const inspectControls = process.env.WORKSPACE_VIEW === "controls";
if (
  process.env.WORKSPACE_SCENE === "populated" ||
  process.env.WORKSPACE_VIEW === "creation" ||
  inspectObjects ||
  inspectControls
) {
  const goto = Page.prototype.goto;
  Page.prototype.goto = async function (...args) {
    const result = await goto.apply(this, args);
    await this.eval(() => {
      if (!document.querySelector(".left-panel")?.checkVisibility())
        [...document.querySelectorAll(".panel-navigation button")]
          .find((b) => /^(Objects|物体)$/.test(b.textContent.trim()))
          ?.click();
    });
    await this.eval(() =>
      document.querySelector('button[aria-label="Add object"], button[aria-label="添加物体"]')?.click(),
    );
    await this.eval(async () => {
      for (let attempt = 0; attempt < 50; attempt++) {
        if (document.querySelector(".add-object-menu")) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error("Add object menu did not open.");
    });
    if (process.env.WORKSPACE_SCENE === "populated" || inspectObjects || inspectControls) {
      await this.eval(() =>
        document
          .querySelector(
            '.add-object-menu [role="menuitem"][aria-label="Add Box"], .add-object-menu [role="menuitem"][aria-label="添加立方体"]',
          )
          ?.click(),
      );
      await this.eval(() => {
        if (document.querySelector(".panel-navigation")?.checkVisibility())
          [...document.querySelectorAll(".panel-navigation button")]
            .find((b) => /^(3D viewport|3D 视口)$/.test(b.textContent.trim()))
            ?.click();
      });
      if (inspectControls) {
        await this.eval(() => {
          const clickTool = (labels) =>
            [...document.querySelectorAll(".quick-tool")]
              .find((button) => labels.includes(button.textContent.trim()))
              ?.click();
          clickTool(["Face", "面"]);
          clickTool(["Move", "移动"]);
        });
      } else if (inspectObjects) {
        await this.eval(() =>
          [...document.querySelectorAll(".panel-navigation button")]
            .find((button) => /^(Objects|物体)$/.test(button.textContent.trim()))
            ?.click(),
        );
      } else {
        await this.eval(() => document.querySelector(".ai-floating-trigger")?.click());
      }
    }
    return result;
  };
}

await import(pathToFileURL(resolve(skillDirectory, "scripts/inspect.mjs")).href);