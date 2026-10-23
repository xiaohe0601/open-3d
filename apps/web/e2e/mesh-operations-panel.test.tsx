import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { initializeI18n } from "../src/i18n";
import { MeshOperationsPanel } from "../src/workspace/mesh-operations-panel";
import { meshOperations, type MeshOperation } from "../src/workspace/modeling";

let container: HTMLDivElement;
let root: Root;
const apply = vi.fn<(operation: MeshOperation, values: Record<string, number | string | boolean>) => void>();

// The deferred mesh panel is tested in isolation, not exposed in the workspace.
function PanelHarness() {
  const [operation, setOperation] = useState<MeshOperation>("mesh.extrude");
  const [values, setValues] = useState<Record<string, number | string | boolean>>({});
  return (
    <MeshOperationsPanel
      operation={operation}
      values={values}
      edgeIds={["edge-1"]}
      eligibility={{ blockers: [] }}
      onOperationChange={setOperation}
      onValuesChange={setValues}
      onApply={() => apply(operation, values)}
    />
  );
}

beforeEach(async () => {
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
  await initializeI18n("en");
  apply.mockClear();
  container = document.createElement("div");
  container.style.width = "300px";
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<PanelHarness />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

test("retains parameter controls for the deferred mesh-operation catalog", async () => {
  const controls = [
    ["Extrude", "Distance"],
    ["Inset faces", "Offset"],
    ["Merge vertices", "Target"],
    ["Dissolve edges", "Preserve boundary"],
    ["Dissolve faces", "Apply operation"],
    ["Bevel edges", "Width"],
    ["Loop cut", "Seed edge"],
    ["Recalculate normals", "Reorients the selected connected mesh component"],
    ["Flip normals", "Reverses the winding of selected faces"],
  ];
  for (const [label, expected] of controls) {
    await act(async () => userEvent.click(page.getByRole("combobox", { name: "Operation", exact: true })));
    await act(async () => userEvent.click(page.getByRole("option", { name: label, exact: true })));
    await expect.element(page.getByText(expected, { exact: true })).toBeVisible();
  }
});

test("routes each deferred catalog selection to its apply callback", async () => {
  for (const [operation, label] of meshOperations) {
    await act(async () => userEvent.click(page.getByRole("combobox", { name: "Operation", exact: true })));
    await act(async () => userEvent.click(page.getByRole("option", { name: label, exact: true })));
    await act(async () => userEvent.click(page.getByRole("button", { name: "Apply operation", exact: true })));
    expect(apply).toHaveBeenLastCalledWith(operation, {});
  }
});

test("preserves deferred parameter drafts while its section is collapsed", async () => {
  const distance = page.getByRole("spinbutton", { name: "Distance", exact: true });
  await act(async () => userEvent.fill(distance, "0.5"));
  const trigger = page.getByRole("button", { name: "Toggle Mesh operations section", exact: true });
  await act(async () => userEvent.click(trigger));
  await expect.element(trigger).toHaveAttribute("aria-expanded", "false");
  await act(async () => userEvent.click(trigger));
  await expect.element(distance).toHaveValue(0.5);
  await act(async () => userEvent.click(page.getByRole("button", { name: "Apply operation", exact: true })));
  expect(apply).toHaveBeenLastCalledWith("mesh.extrude", { distance: 0.5 });
});