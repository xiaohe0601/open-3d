import { act } from "react";
import { expect } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

export async function fill(target: ReturnType<typeof page.getByRole>, text: string) {
  // Durable terminal writes finish outside React's event. Do not hold act open
  // while waiting for the composer to become editable again.
  await expect.element(target).toBeEnabled();
  await act(async () => userEvent.fill(target, text));
}

export async function click(target: ReturnType<typeof page.getByRole>) {
  // Poll async readiness outside act: holding act open while Playwright waits for
  // an enabled control prevents React from committing that very state change.
  await expect.element(target).toBeEnabled();
  await act(async () => userEvent.click(target));
  if (document.querySelector(".ai-floating-content > [role=status]")?.checkVisibility()) {
    // Let Suspense commit before entering an act-wrapped interaction with the lazy panel.
    await expect.element(page.getByRole("region", { name: /^Modra$/ })).toBeInTheDocument();
  }
  await waitForModraReady();
  if (document.querySelector('[data-testid="ai-floating-dialog"][data-open]')) await settleAIPosition();
}

export async function waitForModraReady() {
  if (document.querySelector(".ai-conversation"))
    await expect.poll(() => document.querySelector(".ai-conversation")?.getAttribute("data-modra-ready")).toBe("true");
}

export async function waitForModraIdle() {
  await expect.poll(() => document.querySelector(".ai-conversation")?.getAttribute("data-modra-busy")).toBe("false");
}

export async function settleAIPosition() {
  await expect
    .poll(() => {
      const dialog = document.querySelector<HTMLElement>('[data-testid="ai-floating-dialog"]');
      return Boolean(
        dialog?.checkVisibility() && dialog.style.visibility !== "hidden" && !dialog.getAnimations().length,
      );
    })
    .toBe(true);
}

let creationReturnPanel: string | undefined;
export async function openAddObjectMenu() {
  creationReturnPanel = document.querySelector<HTMLElement>(".studio")?.dataset.panel;
  const left = document.querySelector(".left-panel");
  if (!left?.checkVisibility()) {
    await click(
      page
        .getByRole("navigation", { name: /^(Workspace panels|工作区面板)$/ })
        .getByRole("button", { name: /^(Objects|物体)$/, exact: true }),
    );
  }
  await click(page.getByRole("button", { name: /^(Add object|添加物体)$/ }));
}

export async function addPrimitive(primitive: "box" | "uv-sphere" | "cylinder" = "box") {
  await openAddObjectMenu();
  const names = {
    box: /^(Add Box|添加立方体)$/,
    "uv-sphere": /^(Add Sphere|添加球体)$/,
    cylinder: /^(Add Cylinder|添加圆柱体)$/,
  };
  await click(
    page.getByRole("menu", { name: /^(Add object|添加物体)$/ }).getByRole("menuitem", { name: names[primitive] }),
  );
  if (
    creationReturnPanel &&
    creationReturnPanel !== "scene" &&
    document.querySelector(".panel-navigation")?.checkVisibility()
  ) {
    await click(
      page.getByRole("navigation", { name: /^(Workspace panels|工作区面板)$/ }).getByRole("button", {
        name: creationReturnPanel === "viewport" ? /^(3D viewport|3D 视口)$/ : /^(Properties|属性)$/,
      }),
    );
  }
}

export async function openAISettings() {
  if (!document.querySelector('[data-testid="ai-floating-dialog"]')?.checkVisibility()) {
    await click(page.getByRole("button", { name: /^(AI chat|Modra)$/ }));
  }
  await click(page.getByRole("button", { name: /^(Open AI service settings|打开 AI 服务设置)$/ }));
}